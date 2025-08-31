import React, { useMemo, useState, useEffect } from 'react'
import Papa from 'papaparse'

/** =========================================================================
 *  Violet Crown Pickleball — Standings App (with Guided Matchday for 4/5/6/7/8)
 *  - Events ledger (undo + history) and recomputation of standings
 *  - Guided Matchday: auto-letter seeding, auto-schedule, one-score-at-a-time
 *  - Manual placements still available
 *  - CSV import (4p/8p heuristic) and JSON backup of events ledger
 *  - Tiebreakers: Points → Wins → Points For → Avg Diff
 * ========================================================================= */

const STORAGE_KEY = 'vcc-season-standings-v1'       // derived cache for offline view
const EVENTS_KEY  = 'vcc-events-ledger-v1'          // source of truth (backup this)

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

/** ======================= Guided Matchday Engine ======================= */

// Deterministic hash to pseudo-randomize unknown players consistently
function hashStr(s){ let h=0; for(let i=0;i<s.length;i++){ h=(h<<5)-h + s.charCodeAt(i); h|=0 } return h }
function shuffleDeterministic(arr){ return [...arr].sort((a,b)=> hashStr(a)-hashStr(b)) }

function assignLetters(roster, season, method='standings'){
  const known = []
  const unknown = []
  const seasonMap = season || {}

  roster.forEach(name => {
    if (seasonMap[name]) known.push(name); else unknown.push(name)
  })

  // Sort known by tiebreakers
  const rows = known.map(n => ({ Player:n, ...seasonMap[n] }))
  const sortedKnown = rankPlayers(rows).map(r=>r.Player)

  const afterUnknown = method==='random' ? shuffleDeterministic(unknown) : shuffleDeterministic(unknown)
  const ordered = [...sortedKnown, ...afterUnknown]

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const map = {}
  ordered.forEach((name, idx)=> { map[letters[idx]] = name })
  return map // e.g., {A:"Nathaniel", B:"Alex", ...}
}

function letterPairToNames(pair, L){ return pair.map(ch => L[ch]) }

// Build the exact event-day schedule by size, using your provided charts
function buildSchedule(size, lettersMap){
  const L = lettersMap
  const P = (l1,l2) => ({ stage:'pool', to:11, winBy:1, pair1:l1, pair2:l2 })
  const B = (l1,l2,label) => ({ stage:'bracket', to:15, winBy:2, pair1:l1, pair2:l2, label })

  // helper to turn like 'AB' into ['A','B']
  const t = s => [s[0], s[1]]

  const schedule = []

  if (size===4){
    schedule.push(
      P(t('AB'), t('CD')),
      P(t('AD'), t('BC')),
      P(t('AC'), t('BD')),
      B(t('AB'), t('CD'), 'Final')
    )
  }

  if (size===5){
    schedule.push(
      P(t('AC'), t('DE')),
      P(t('AE'), t('BD')),
      P(t('AD'), t('BC')),
      P(t('AE'), t('BC')),
      P(t('BE'), t('CD')),
      B(t('AB'), t('CD'), 'Final') // 3rd will be E by structure
    )
  }

  if (size===6){
    schedule.push(
      P(t('AB'), t('CD')),
      P(t('AF'), t('BE')),
      P(t('CD'), t('EF')),
      P(t('AD'), t('BC')),
      P(t('AE'), t('BF')),
      P(t('CF'), t('DE')),
      B(t('CD'), t('EF'), 'SF'),
      { stage:'bracket-dynamic-final', to:15, winBy:2, label:'Final', fixedPair1: t('AB'), from:'prev-winner' }
    )
  }

  if (size===7){
    schedule.push(
      P(t('AG'), t('CE')),
      P(t('BF'), t('DG')),
      P(t('AC'), t('EF')),
      P(t('BD'), t('EG')),
      P(t('AD'), t('CF')),
      P(t('BC'), t('AF')),
      P(t('BG'), t('DE')),
      B(t('CD'), t('EF'), 'SF'),
      { stage:'bracket-dynamic-final', to:15, winBy:2, label:'Final', fixedPair1: t('AB'), from:'prev-winner' }
    )
  }

  if (size===8){
    schedule.push(
      P(t('AC'), t('EG')),
      P(t('BD'), t('FH')),
      P(t('AG'), t('CE')),
      P(t('BH'), t('DF')),
      P(t('AE'), t('CG')),
      P(t('BF'), t('DH')),
      B(t('AB'), t('GH'), 'SF1'),
      B(t('CD'), t('EF'), 'SF2'),
      B(t('EF'), t('GH'), 'Bronze'), // losers of SFs
      B(t('AB'), t('CD'), 'Final')   // winners of SFs
    )
  }

  // Expand letters to names at render time; we keep letters too for placements logic
  return schedule
}

/** Compute placements at the end based on size + collected bracket results */
function computePlacements(size, schedule, results, lettersMap){
  const L = lettersMap
  const placements = { 1:[], 2:[], 3:[], 4:[] }

  function winnerOf(matchIdx){ const r = results[matchIdx]; return (r && r.winner) || null }
  function loserOf(matchIdx){ const r = results[matchIdx]; return (r && r.loser)  || null }

  // Helper to extract team arrays (names) from letters array like ['A','B']
  const namesOf = (letters) => letters.map(ch => L[ch])

  if (size===4){
    // last match is Final
    const idxFinal = schedule.findIndex(m => m.label==='Final')
    const w = winnerOf(idxFinal); const l = loserOf(idxFinal)
    placements[1]=w; placements[2]=l
    return prunePlacements(placements)
  }

  if (size===5){
    const idxFinal = schedule.findIndex(m => m.label==='Final')
    const w = winnerOf(idxFinal); const l = loserOf(idxFinal)
    placements[1]=w; placements[2]=l
    // 3rd is player E (single)
    placements[3]=[L['E']]
    return prunePlacements(placements)
  }

  if (size===6){
    const idxSF = schedule.findIndex(m => m.label==='SF')
    const idxFinal = schedule.findIndex(m => m.label==='Final')
    const w = winnerOf(idxFinal); const l = loserOf(idxFinal)
    placements[1]=w; placements[2]=l
    const semiLoser = loserOf(idxSF)
    placements[3]=semiLoser || []
    return prunePlacements(placements)
  }

  if (size===7){
    const idxSF = schedule.findIndex(m => m.label==='SF')
    const idxFinal = schedule.findIndex(m => m.label==='Final')
    const w = winnerOf(idxFinal); const l = loserOf(idxFinal)
    placements[1]=w; placements[2]=l
    placements[3]=loserOf(idxSF) || []
    // 4th is the single player G by structure
    placements[4]=[L['G']]
    return prunePlacements(placements)
  }

  if (size===8){
    const idxBronze = schedule.findIndex(m => m.label==='Bronze')
    const idxFinal = schedule.findIndex(m => m.label==='Final')
    placements[1]=winnerOf(idxFinal); placements[2]=loserOf(idxFinal)
    placements[3]=winnerOf(idxBronze); placements[4]=loserOf(idxBronze)
    return prunePlacements(placements)
  }

  return prunePlacements(placements)
}

function prunePlacements(p){
  // Remove empty arrays and undefined placements keys without awards
  const out = {}
  Object.entries(p).forEach(([k,v])=>{ if (Array.isArray(v) && v.length) out[k]=v })
  return out
}

/** ============================ App Root ============================ */
export default function App(){
  /** Source of truth */
  const [events, setEvents] = useState(loadEvents())
  /** Derived standings */
  const [season, setSeason] = useState({})
  /** Views */
  const [view, setView] = useState('standings')

  useEffect(()=>{
    const recomputed = recomputeFromLedger(events)
    setSeason(recomputed)
    persistSeason(recomputed)
    saveEvents(events)
  }, [events])

  const rows = useMemo(()=>{
    const list = Object.keys(season).map(name => ({ Player: name, ...season[name] }))
    return rankPlayers(list)
  }, [season])

  const addPlacementEvent = ({ size, placements, gameStats }) => {
    setEvents(prev => [...prev, { id: Date.now(), size, placements, gameStats }])
    alert('Event added to standings')
  }

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

      {view==='add' && <AddEventForm season={season} onAdd={addPlacementEvent} />}

      {view==='history' && (
        <HistoryView events={events} onDelete={(id)=>{
          if (confirm('Delete this event from history?')) setEvents(prev => prev.filter(e => e.id !== id))
        }} />
      )}

      {view==='data' && <DataPanel setEvents={setEvents} />}
    </div>
  )
}

/** ---------------- Views & Panels ---------------- */

function AddEventForm({ season, onAdd }){
  const [size, setSize] = useState(4)
  const [roster, setRoster] = useState('')
  const [guided, setGuided] = useState(true)
  const [method, setMethod] = useState('standings') // 'standings' | 'random'

  // Manual placements state (fallback)
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const [p3, setP3] = useState('')
  const [p4, setP4] = useState('')
  const [games, setGames] = useState([])

  // Guided state machine
  const [letters, setLetters] = useState(null)      // {A: name, ...}
  const [schedule, setSchedule] = useState([])      // array of match defs
  const [matchIdx, setMatchIdx] = useState(-1)      // -1 before start
  const [results, setResults] = useState({})        // { idx: {team1:[names], team2:[names], s1, s2, winner:[..], loser:[..]} }

  const names = useMemo(()=> roster.split(',').map(s=>s.trim()).filter(Boolean), [roster])
  const info = POINTS_TABLE[size]
  const needsThird  = Boolean(info.awards[3])
  const needsFourth = Boolean(info.awards[4])

  const startGuided = () => {
    if (names.length !== size) return alert(`This event size requires exactly ${size} players in the roster`)
    const L = assignLetters(names, season, method)
    setLetters(L)
    const sched = buildSchedule(size, L)
    setSchedule(sched)
    setMatchIdx(0)
    setResults({})
  }

  const currentMatch = matchIdx>=0 ? schedule[matchIdx] : null

  function resolveTeamsForMatch(m){
    if (!m) return null
    const L = letters
    if (m.stage==='pool' || m.stage==='bracket'){
      return {
        team1: m.pair1.map(ch => L[ch]),
        team2: m.pair2.map(ch => L[ch])
      }
    }
    if (m.stage==='bracket-dynamic-final'){
      // team1 is fixedPair1 (AB); team2 is winner of previous match
      const prevIdx = schedule.findIndex(x => x.label==='SF')
      const prev = results[prevIdx]
      const t1 = m.fixedPair1.map(ch => L[ch])
      const t2 = prev ? prev.winner : ['(winner TBD)','']
      return { team1: t1, team2: t2 }
    }
    return null
  }

  function submitScore(e){
    e.preventDefault()
    const m = currentMatch
    if (!m) return
    const { team1, team2 } = resolveTeamsForMatch(m)
    const s1 = +(e.target.s1.value||0)
    const s2 = +(e.target.s2.value||0)

    // basic validation (soft)
    if (m.stage!=='pool'){
      // bracket: prefer to 15 win-by-2
      if (Math.max(s1,s2) < 11) { if (!confirm('Bracket games are typically to 15. Continue?')) return }
      if (Math.abs(s1-s2) < 2)  { if (!confirm('Bracket games are win-by-2. Continue?')) return }
    } else {
      // pool: to 11, win-by-1
      if (Math.max(s1,s2) < 11) { if (!confirm('Pool games are typically to 11. Continue?')) return }
    }

    const winner = s1>s2 ? team1 : team2
    const loser  = s1>s2 ? team2 : team1

    const rec = { team1, team2, s1, s2, winner, loser, stage:m.stage, label:m.label||'' }
    setResults(r => ({ ...r, [matchIdx]: rec }))
    setGames(g => [...g, { team1, team2, s1, s2 }])

    // advance or finish
    if (matchIdx < schedule.length - 1){
      setMatchIdx(matchIdx + 1)
    } else {
      // finished all matches → compute placements and submit event
      const placements = computePlacements(size, schedule, { ...results, [matchIdx]: rec }, letters)
      onAdd({ size, placements, gameStats: [...games, { team1, team2, s1, s2 }] })
      // reset guided state
      setMatchIdx(-1); setSchedule([]); setResults({}); setLetters(null); setGames([])
    }
  }

  const updateGame = (idx, key, val)=> setGames(g=> g.map((row,i)=> i===idx? { ...row, [key]:val } : row))
  const addGameRow = ()=> setGames(g=>[...g, { team1:["",""], team2:["",""], s1:11, s2:8 }])

  return (
    <section className="card">
      <h2 style={{marginTop:0}}>Add Event</h2>

      <div className="grid" style={{gap:16}}>
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
          <label>Guided Matchday</label>
          <div className="row">
            <label className="row" style={{gap:6}}>
              <input type="checkbox" checked={guided} onChange={e=>setGuided(e.target.checked)} /> Enable guided prompts
            </label>
          </div>
        </div>

        {guided && (
          <div className="grid" style={{gap:8}}>
            <div>
              <label>Seeding Method</label>
              <select value={method} onChange={e=>setMethod(e.target.value)}>
                <option value="standings">Use current standings</option>
                <option value="random">Randomize (Week 1 / newcomers)</option>
              </select>
            </div>
            <div className="row" style={{gap:8}}>
              <button className="btn" onClick={startGuided}>Start Guided Matchday</button>
            </div>

            {letters && (
              <div className="card" style={{border:'1px dashed #e5e7eb'}}>
                <strong>Letter Assignments:</strong>
                <div className="row" style={{gap:12, flexWrap:'wrap', marginTop:8}}>
                  {Object.entries(letters).map(([k,v])=> (
                    <span key={k}><strong>{k}</strong>= {v}</span>
                  ))}
                </div>
              </div>
            )}

            {matchIdx>=0 && (
              <GuidedMatchPrompt
                match={currentMatch}
                schedule={schedule}
                results={results}
                resolveTeams={()=>resolveTeamsForMatch(currentMatch)}
                onSubmit={submitScore}
                matchIdx={matchIdx}
                total={schedule.length}
              />
            )}
          </div>
        )}

        {!guided && (
          <div className="grid" style={{gap:16}}>
            <h3 style={{margin:'8px 0'}}>Manual Placements</h3>
            <div className="row" style={{gap:8, flexWrap:'wrap'}}>
              <div>
                <label>Champions (1st) — Player 1</label>
                <input list="rosterlist" value={p1} onChange={e=>setP1(e.target.value)} placeholder="Player" />
              </div>
              <div>
                <label>Champions (1st) — Player 2</label>
                <input list="rosterlist" value={p2} onChange={e=>setP2(e.target.value)} placeholder="Player" />
              </div>
              <div>
                <label>Runners-up (2nd) — Player 1</label>
                <input list="rosterlist" value={p3} onChange={e=>setP3(e.target.value)} placeholder="Player" />
              </div>
              <div>
                <label>Runners-up (2nd) — Player 2</label>
                <input list="rosterlist" value={p4} onChange={e=>setP4(e.target.value)} placeholder="Player" />
              </div>
            </div>

            {(POINTS_TABLE[size].awards[3] || POINTS_TABLE[size].awards[4]) && (
              <div className="row" style={{gap:8, flexWrap:'wrap'}}>
                {POINTS_TABLE[size].awards[3] && (
                  <div>
                    <label>Third Place (single player)</label>
                    <input list="rosterlist" value={p3} onChange={e=>setP3(e.target.value)} placeholder="Player" />
                  </div>
                )}
                {POINTS_TABLE[size].awards[4] && (
                  <div>
                    <label>Fourth Place (single player)</label>
                    <input list="rosterlist" value={p4} onChange={e=>setP4(e.target.value)} placeholder="Player" />
                  </div>
                )}
              </div>
            )}

            <div>
              <div className="muted">Optional: enter game scores to accumulate Wins/Losses & PF/PA</div>
              <button type="button" className="btn" onClick={()=>setGames(g=>[...g, { team1:["",""], team2:["",""], s1:11, s2:8 }])}>Add Game</button>
            </div>

            {games.map((g,idx)=> (
              <div key={idx} className="grid" style={{gridTemplateColumns:"repeat(12, 1fr)", gap:8}}>
                <input list="rosterlist" value={g.team1?.[0]||''} onChange={e=>updateGame(idx,'team1',[e.target.value, g.team1?.[1]||''])} placeholder="Team1 P1" />
                <input list="rosterlist" value={g.team1?.[1]||''} onChange={e=>updateGame(idx,'team1',[g.team1?.[0]||'', e.target.value])} placeholder="Team1 P2" />
                <input list="rosterlist" value={g.team2?.[0]||''} onChange={e=>updateGame(idx,'team2',[e.target.value, g.team2?.[1]||''])} placeholder="Team2 P1" />
                <input list="rosterlist" value={g.team2?.[1]||''} onChange={e=>updateGame(idx,'team2',[g.team2?.[0]||'', e.target.value])} placeholder="Team2 P2" />
                <input type="number" min="0" value={g.s1} onChange={e=>updateGame(idx,'s1',e.target.value)} />
                <input type="number" min="0" value={g.s2} onChange={e=>updateGame(idx,'s2',e.target.value)} />
              </div>
            ))}

            <button className="btn primary" onClick={(e)=>{
              e.preventDefault()
              if (!p1||!p2||!p3||!p4) return alert('Please fill 1st and 2nd pairs (two players each). For sizes that award 3rd/4th, also fill those.')
              const placements = { 1:[p1,p2], 2:[p3,p4] }
              if (POINTS_TABLE[size].awards[3]) placements[3] = [p3] // allow single player entry
              if (POINTS_TABLE[size].awards[4]) placements[4] = [p4]
              const gameStats = games.filter(g=>g.team1[0]&&g.team1[1]&&g.team2[0]&&g.team2[1]).map(g=>({ team1:g.team1, team2:g.team2, s1:+g.s1, s2:+g.s2 }))
              onAdd({ size, placements, gameStats })
            }}>Add Event to Standings</button>
          </div>
        )}
      </div>

      {/* datalist for quick type-ahead */}
      <datalist id="rosterlist">
        {names.map(n=> <option key={n} value={n} />)}
      </datalist>
    </section>
  )
}

function GuidedMatchPrompt({ match, schedule, results, resolveTeams, onSubmit, matchIdx, total }){
  const resolved = resolveTeams()
  const label = match.label || (match.stage==='pool' ? `Pool` : 'Bracket')
  return (
    <form onSubmit={onSubmit} className="card" style={{marginTop:12}}>
      <div className="row" style={{justifyContent:'space-between'}}>
        <strong>Match {matchIdx+1} of {total} — {label}</strong>
        <span className="muted">{match.stage==='pool' ? 'to 11, win by 1' : 'to 15, win by 2'}</span>
      </div>
      <div className="row" style={{gap:8, flexWrap:'wrap', marginTop:8}}>
        <strong>{resolved?.team1?.join(' & ')} </strong>
        <span className="muted">vs</span>
        <strong>{resolved?.team2?.join(' & ')}</strong>
      </div>
      <div className="row" style={{gap:8, marginTop:8}}>
        <input name="s1" type="number" min="0" placeholder="Team 1 score" required />
        <input name="s2" type="number" min="0" placeholder="Team 2 score" required />
        <button className="btn primary" type="submit">Submit Score</button>
      </div>
    </form>
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
                  {Object.entries(ev.placements).map(([place, arr])=> (
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
