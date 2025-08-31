import React, { useMemo, useState, useEffect } from 'react'
import Papa from 'papaparse'

/** =========================================================================
 *  Violet Crown Pickleball — Standings App (with Undo & History)
 *  - Tracks an events ledger and recomputes standings from it
 *  - Undo Last Event + History view to delete any event
 *  - CSV import (4p/8p heuristic) and JSON backup of the ledger
 *  - Tiebreakers: Points → Wins → Points For → Avg Diff
 * ========================================================================= */

const STORAGE_KEY = 'vcc-season-standings-v1'       // derived, for quick viewing/offline cache
const EVENTS_KEY  = 'vcc-events-ledger-v1'          // source of truth (recommended to back up)

/** Points table from your rules */
const POINTS_TABLE = {
  8: { label: 'Slam',       awards: { 1: 1000, 2: 600, 3: 250, 4: 100 } },
  7: { label: 'Signature',  awards: { 1: 700,  2: 400, 3: 100, 4: 50  } },
  6: { label: 'Signature',  awards: { 1: 600,  2: 300, 3: 100           } },
  5: { label: 'Challenger', awards: { 1: 300,  2: 100, 3: 50            } },
  4: { label: 'Challenger', awards: { 1: 250,  2: 100                    } },
}

const emptyTotals = () => ({
  Points: 0, Wins: 0, Losses: 0, PF: 0, PA: 0,
  SlamWins: 0, SignatureWins: 0, ChallengerWins: 0
})

const calcAvgDiff = p => {
  const gp = p.Wins + p.Losses
  return gp ? (p.PF - p.PA) / gp : 0
}

/** Tiebreakers: Points → Wins → Points For → Avg Diff → name */
const rankPlayers = rows => {
  return [...rows].sort((a,b)=>{
    if (b.Points !== a.Points) return b.Points - a.Points
    if (b.Wins   !== a.Wins)   return b.Wins   - a.Wins
    if (b.PF     !== a.PF)     return b.PF     - a.PF
    const ad = calcAvgDiff(b) - calcAvgDiff(a)
    if (ad !== 0) return ad > 0 ? 1 : -1
    return a.Player.localeCompare(b.Player)
  }).map((r,i)=> ({ ...r, Rank: i+1, AvgDiff: +calcAvgDiff(r).toFixed(2) }))
}

/** ------- Events ledger helpers ------- */
const loadEvents = () => { try { return JSON.parse(localStorage.getItem(EVENTS_KEY)) || [] } catch { return [] } }
const saveEvents = (arr) => localStorage.setItem(EVENTS_KEY, JSON.stringify(arr))
const persistSeason = (season) => localStorage.setItem(STORAGE_KEY, JSON.stringify(season))

/** Apply a single event to season totals */
function applyEventToSeason(season, ev) {
  const { size, placements, gameStats = [] } = ev
  const info = POINTS_TABLE[size]
  if (!info) return season
  const label = info.label
  const next = { ...season }

  // Placement points + title counts
  Object.entries(placements).forEach(([place, players])=>{
    const pts = info.awards[place]
    if (!pts) return
    ;(players || []).forEach(p=>{
      const n = (p || '').trim()
      if (!n) return
      next[n] = next[n] || emptyTotals()
      next[n].Points += pts
      if (label==='Slam'       && place==='1') next[n].SlamWins++
      if (label==='Signature'  && place==='1') next[n].SignatureWins++
      if (label==='Challenger' && place==='1') next[n].ChallengerWins++
    })
  })

  // Optional per-game stats
  gameStats.forEach(({ team1, team2, s1, s2 })=>{
    team1.forEach(p=>{ next[p]=next[p]||emptyTotals(); next[p].PF += s1; next[p].PA += s2 })
    team2.forEach(p=>{ next[p]=next[p]||emptyTotals(); next[p].PF += s2; next[p].PA += s1 })
    if (s1 > s2) { team1.forEach(p=> next[p].Wins++); team2.forEach(p=> next[p].Losses++) }
    else if (s2 > s1) { team2.forEach(p=> next[p].Wins++); team1.forEach(p=> next[p].Losses++) }
  })

  return next
}

/** Recompute full season from the ledger (authoritative) */
function recomputeFromLedger(events){
  let season = {}
  events.forEach(ev => { season = applyEventToSeason(season, ev) })
  return season
}

export default function App(){
  /** Source of truth */
  const [events, setEvents] = useState(loadEvents())

  /** Derived standings (recomputed whenever events change) */
  const [season, setSeason] = useState({})

  /** Simple views */
  const [view, setView] = useState('standings')

  /** On events change: recompute season + persist */
  useEffect(()=>{
    const recomputed = recomputeFromLedger(events)
    setSeason(recomputed)
    persistSeason(recomputed) // cache for offline
    saveEvents(events)        // store ledger
  }, [events])

  /** Build rows for standings table */
  const rows = useMemo(()=>{
    const list = Object.keys(season).map(name => ({ Player: name, ...season[name] }))
    return rankPlayers(list)
  }, [season])

  /** Add event -> push to ledger */
  const addPlacementEvent = ({ size, placements, gameStats }) => {
    setEvents(prev => [...prev, { id: Date.now(), size, placements, gameStats }])
    alert('Event added to standings')
  }

  /** Undo last event */
  const undoLast = () => {
    if (!events.length) return alert('Nothing to undo')
    if (confirm('Undo the last event?')) setEvents(evts => evts.slice(0, -1))
  }

  return (
    <div className="container">
      <header>
        <h1>Violet Crown Pickleball — Standings</h1>
        <div className="tabs">
          <button className="btn" onClick={()=>setView('standings')}>Standings</button>
          <button className="btn" onClick={()=>setView('add')}>Add Event</button>
          <button className="btn" onClick={()=>setView('history')}>History</button>
          <button className="btn" onClick={()=>setView('data')}>Data</button>
        </div>
      </header>

      {(view==='standings' || view==='add') && (
        <div style={{margin:'12px 0'}}>
          <button className="btn" onClick={undoLast}>Undo Last Event</button>
        </div>
      )}

      {view==='standings' && (
        <section className="card">
          <div style={{overflowX:'auto'}}>
            <table>
              <thead>
                <tr>
                  <th>Rank</th><th>Player</th><th>Points</th><th>Wins</th><th>Losses</th>
                  <th>Points For</th><th>Points Against</th>
                  <th>Slam Wins</th><th>Signature Wins</th><th>Challenger Wins</th><th>Avg Diff</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r=> (
                  <tr key={r.Player}>
                    <td><strong>{r.Rank}</strong></td>
                    <td>{r.Player}</td>
                    <td>{r.Points}</td>
                    <td>{r.Wins}</td>
                    <td>{r.Losses}</td>
                    <td>{r.PF}</td>
                    <td>{r.PA}</td>
                    <td>{r.SlamWins}</td>
                    <td>{r.SignatureWins}</td>
                    <td>{r.ChallengerWins}</td>
                    <td>{r.AvgDiff}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {view==='add' && <AddEventForm onAdd={addPlacementEvent} />}

      {view==='history' && (
        <HistoryView events={events} onDelete={(id)=>{
          if (confirm('Delete this event from history?')) {
            setEvents(prev => prev.filter(e => e.id !== id))
          }
        }} />
      )}

      {view==='data' && <DataPanel setEvents={setEvents} />}
    </div>
  )
}

/** ---------------- Views & Panels ---------------- */

function AddEventForm({ onAdd }){
  const [size, setSize] = useState(4)
  const [roster, setRoster] = useState('')

  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const [p3, setP3] = useState('')
  const [p4, setP4] = useState('')
  const [third, setThird] = useState('')
  const [fourth, setFourth] = useState('')

  const [games, setGames] = useState([])

  const names = useMemo(()=> roster.split(',').map(s=>s.trim()).filter(Boolean), [roster])
  const info = POINTS_TABLE[size]
  const needsThird  = Boolean(info.awards[3])
  const needsFourth = Boolean(info.awards[4])

  const addGameRow = ()=> setGames(g=>[...g, { team1:["",""], team2:["",""], s1:11, s2:8 }])
  const updateGame = (idx, key, val)=> setGames(g=> g.map((row,i)=> i===idx? { ...row, [key]:val } : row))

  const submit = e => {
    e.preventDefault()
    if (!p1 || !p2) return alert('Select champions (1st) team')
    if (!p3 || !p4) return alert('Select runners-up (2nd) team')

    const placements = { 1:[p1,p2], 2:[p3,p4] }
    if (needsThird && third)   placements[3] = [third]
    if (needsFourth && fourth) placements[4] = [fourth]

    const gameStats = games
      .filter(g=>g.team1[0]&&g.team1[1]&&g.team2[0]&&g.team2[1])
      .map(g=>({ team1:g.team1, team2:g.team2, s1:+g.s1, s2:+g.s2 }))

    onAdd({ size, placements, gameStats })
  }

  return (
    <section className="card">
      <h2 style={{marginTop:0}}>Add Event (Manual Placements)</h2>
      <form onSubmit={submit} className="grid" style={{gap:16}}>
        <div>
          <label>Event Size</label>
          <select value={size} onChange={e=>setSize(+e.target.value)}>
            <option value={4}>4 players (Challenger)</option>
            <option value={5}>5 players (Challenger)</option>
            <option value={6}>6 players (Signature)</option>
            <option value={7}>7 players (Signature)</option>
            <option value={8}>8 players (Slam)</option>
          </select>
        </div>
        <div>
          <label>Event Roster (comma-separated)</label>
          <input value={roster} onChange={e=>setRoster(e.target.value)} placeholder="Nathaniel, Alex, Bill, Reinaldo" />
        </div>

        <div>
          <label>Champions (1st) — Player 1</label>
          <select value={p1} onChange={e=>setP1(e.target.value)}>
            <option value="">Select player</option>
            {names.map(n=> <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <label>Champions (1st) — Player 2</label>
          <select value={p2} onChange={e=>setP2(e.target.value)}>
            <option value="">Select player</option>
            {names.map(n=> <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        <div>
          <label>Runners-up (2nd) — Player 1</label>
          <select value={p3} onChange={e=>setP3(e.target.value)}>
            <option value="">Select player</option>
            {names.map(n=> <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <label>Runners-up (2nd) — Player 2</label>
          <select value={p4} onChange={e=>setP4(e.target.value)}>
            <option value="">Select player</option>
            {names.map(n=> <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        {needsThird && (
          <div>
            <label>Third Place (single player)</label>
            <select value={third} onChange={e=>setThird(e.target.value)}>
              <option value="">Select player</option>
              {names.map(n=> <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        )}
        {needsFourth && (
          <div>
            <label>Fourth Place (single player)</label>
            <select value={fourth} onChange={e=>setFourth(e.target.value)}>
              <option value="">Select player</option>
              {names.map(n=> <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        )}

        <div>
          <div className="muted">Optional: enter game scores to accumulate Wins/Losses & PF/PA</div>
          <button type="button" className="btn" onClick={addGameRow}>Add Game</button>
        </div>

        {games.map((g,idx)=> (
          <div key={idx} className="grid" style={{gridTemplateColumns:"repeat(12, 1fr)", gap:8}}>
            <select value={g.team1[0]} onChange={e=>updateGame(idx,'team1',[e.target.value,g.team1[1]])}>
              <option value="">Team1 P1</option>
              {names.map(n=> <option key={n} value={n}>{n}</option>)}
            </select>
            <select value={g.team1[1]} onChange={e=>updateGame(idx,'team1',[g.team1[0],e.target.value])}>
              <option value="">Team1 P2</option>
              {names.map(n=> <option key={n} value={n}>{n}</option>)}
            </select>
            <select value={g.team2[0]} onChange={e=>updateGame(idx,'team2',[e.target.value,g.team2[1]])}>
              <option value="">Team2 P1</option>
              {names.map(n=> <option key={n} value={n}>{n}</option>)}
            </select>
            <select value={g.team2[1]} onChange={e=>updateGame(idx,'team2',[g.team2[0],e.target.value])}>
              <option value="">Team2 P2</option>
              {names.map(n=> <option key={n} value={n}>{n}</option>)}
            </select>
            <input type="number" min="0" value={g.s1} onChange={e=>updateGame(idx,'s1',e.target.value)} />
            <input type="number" min="0" value={g.s2} onChange={e=>updateGame(idx,'s2',e.target.value)} />
          </div>
        ))}

        <button type="submit" className="btn primary">Add Event to Standings</button>
      </form>
    </section>
  )
}

function HistoryView({ events, onDelete }){
  return (
    <section className="card">
      <h2 style={{marginTop:0}}>Event History</h2>
      {!events.length && <p className="muted">No events yet.</p>}
      {!!events.length && (
        <table>
          <thead>
            <tr><th>#</th><th>Size</th><th>Placements</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {events.map((ev, idx)=>(
              <tr key={ev.id}>
                <td>{idx+1}</td>
                <td>{ev.size}</td>
                <td>
                  {Object.entries(ev.placements).map(([place, arr])=>(
                    <span key={place} style={{marginRight:8}}>
                      <strong>{place}:</strong> {arr.join(', ')}
                    </span>
                  ))}
                </td>
                <td>
                  <button className="btn" onClick={()=>onDelete(ev.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted" style={{marginTop:8}}>Deleting an event will instantly recompute the standings from the remaining events.</p>
    </section>
  )
}

function DataPanel({ setEvents }){
  /** Export the authoritative ledger */
  const exportEvents = () => {
    const data = localStorage.getItem(EVENTS_KEY) || '[]'
    const blob = new Blob([data], { type:'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'vcc-events-ledger.json'
    a.click()
  }

  /** Import the ledger and recompute */
  const importEvents = e => {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const arr = JSON.parse(reader.result)
        if (!Array.isArray(arr)) throw new Error('Invalid events JSON')
        setEvents(arr)
        alert('Events ledger imported')
      } catch { alert('Invalid JSON') }
    }
    reader.readAsText(file)
  }

  /** CSV import (beta: 4p/8p) → converts to a single event and appends */
  const importCSV = e => {
    const file = e.target.files?.[0]; if (!file) return
    Papa.parse(file, {
      complete: (results) => {
        try {
          const rows = results.data.filter(r => r && r.length >= 6)
          if (!rows.length) return alert('CSV seems empty')
          let size = 0; let games = []
          if ((rows[0][0]||'').toUpperCase()==='EVENT') { size = parseInt(rows[0][3],10); games = rows.slice(1) } else { games = rows }
          const gameStats = games.map(r => ({
            team1:[String(r[0]).trim(), String(r[1]).trim()],
            team2:[String(r[2]).trim(), String(r[3]).trim()],
            s1:+r[4], s2:+r[5]
          }))
          let placements = {}
          if (size===4) {
            const f = gameStats[gameStats.length-1]
            const champs  = f.s1>f.s2 ? f.team1 : f.team2
            const runners = f.s1>f.s2 ? f.team2 : f.team1
            placements = { 1: champs, 2: runners }
          } else if (size===8) {
            const [sf1,sf2,bronze,final] = gameStats.slice(-4)
            const champs  = final.s1>final.s2 ? final.team1 : final.team2
            const runners = final.s1>final.s2 ? final.team2 : final.team1
            const third   = bronze.s1>bronze.s2 ? bronze.team1 : bronze.team2
            const fourth  = bronze.s1>bronze.s2 ? bronze.team2 : bronze.team1
            placements = { 1: champs, 2: runners, 3: third, 4: fourth }
          } else {
            return alert('CSV auto-placements supported for 4p/8p now. Use the Add Event form for 5/6/7.')
          }
          // Append as one event to the ledger
          setEvents(prev => [...prev, { id: Date.now(), size, placements, gameStats }])
          alert('CSV event imported')
        } catch (e) {
          console.error(e); alert('CSV parse failed')
        }
      }
    })
  }

  return (
    <section className="card" style={{display:'grid', gap:12}}>
      <h2 style={{marginTop:0}}>Data & Backups</h2>
      <div className="row" style={{gap:12, flexWrap:'wrap'}}>
        <button className="btn" onClick={exportEvents}>Export Events Ledger (JSON)</button>
        <label className="btn" style={{cursor:'pointer'}}>
          Import Events Ledger (JSON)
          <input type="file" accept="application/json" style={{display:'none'}} onChange={importEvents} />
        </label>
        <label className="btn" style={{cursor:'pointer'}}>
          Import Event CSV (beta: 4p/8p)
          <input type="file" accept=".csv" style={{display:'none'}} onChange={importCSV} />
        </label>
      </div>
      <p className="muted">Tip: back up the <strong>Events Ledger</strong>. Standings are always recomputed from it.</p>
    </section>
  )
}
