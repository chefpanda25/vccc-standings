import React, { useMemo, useState, useEffect } from 'react'
import Papa from 'papaparse'

/** =========================================================================
 *  Violet Crown Pickleball — Standings App (Guided Matchday + Reseed Bracket)
 *  - Events ledger (undo + history) and recomputation of standings
 *  - Guided Matchday for 4/5/6/7/8 with **post-pool reseeding**
 *  - Shows every logged game (stage-labeled) while adding AND in history
 *  - Manual placements still available
 *  - CSV import (4p/8p heuristic) and JSON backup of events ledger
 *  - Tiebreakers: Points → Wins → Points For → Avg Diff
 * ========================================================================= */

const STORAGE_KEY = 'vcc-season-standings-v1'       // derived cache for offline view
const EVENTS_KEY  = 'vcc-events-ledger-v1'          // source of truth (backup this)

/** Points table (updated):
 *  - 5-player: last place (5th) gets 50
 *  - 7-player: last place (7th) gets 50
 */
const POINTS_TABLE = {
  8: { label: 'Slam',       awards: { 1: 1000, 2: 600, 3: 250, 4: 100 } },
  7: { label: 'Signature',  awards: { 1: 700,  2: 400, 3: 100, 7: 50  } },
  6: { label: 'Signature',  awards: { 1: 600,  2: 300, 3: 100           } },
  5: { label: 'Challenger', awards: { 1: 300,  2: 100, 5: 50            } },
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

  // Per-game stats (PF/PA + W/L). Note: each player on a team gets the team score.
  gameStats.forEach(({ team1=[], team2=[], s1=0, s2=0 })=>{
    team1.forEach(p=>{ next[p]=next[p]||emptyTotals(); next[p].PF += +s1; next[p].PA += +s2 })
    team2.forEach(p=>{ next[p]=next[p]||emptyTotals(); next[p].PF += +s2; next[p].PA += +s1 })
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

// Build ONLY the pool schedule by size (letters, not names yet)
function buildPoolSchedule(size){
  const t = s => [s[0], s[1]]
  const P = (l1,l2,label) => ({ phase:'pool', to:11, winBy:1, pair1:l1, pair2:l2, label })
  const pool = []

  if (size===4){
    pool.push(P(t('AB'), t('CD'), 'Pool 1'))
    pool.push(P(t('AD'), t('BC'), 'Pool 2'))
    pool.push(P(t('AC'), t('BD'), 'Pool 3'))
  }
  if (size===5){
    pool.push(P(t('AC'), t('DE'), 'Pool 1'))
    pool.push(P(t('AE'), t('BD'), 'Pool 2'))
    pool.push(P(t('AD'), t('BC'), 'Pool 3'))
    pool.push(P(t('AE'), t('BC'), 'Pool 4'))
    pool.push(P(t('BE'), t('CD'), 'Pool 5'))
  }
  if (size===6){
    pool.push(P(t('AB'), t('CD'), 'Pool 1'))
    pool.push(P(t('AF'), t('BE'), 'Pool 2'))
    pool.push(P(t('CD'), t('EF'), 'Pool 3'))
    pool.push(P(t('AD'), t('BC'), 'Pool 4'))
    pool.push(P(t('AE'), t('BF'), 'Pool 5'))
    pool.push(P(t('CF'), t('DE'), 'Pool 6'))
  }
  if (size===7){
    pool.push(P(t('AG'), t('CE'), 'Pool 1'))
    pool.push(P(t('BF'), t('DG'), 'Pool 2'))
    pool.push(P(t('AC'), t('EF'), 'Pool 3'))
    pool.push(P(t('BD'), t('EG'), 'Pool 4'))
    pool.push(P(t('AD'), t('CF'), 'Pool 5'))
    pool.push(P(t('BC'), t('AF'), 'Pool 6'))
    pool.push(P(t('BG'), t('DE'), 'Pool 7'))
  }
  if (size===8){
    pool.push(P(t('AC'), t('EG'), 'Pool 1'))
    pool.push(P(t('BD'), t('FH'), 'Pool 2'))
    pool.push(P(t('AG'), t('CE'), 'Pool 3'))
    pool.push(P(t('BH'), t('DF'), 'Pool 4'))
    pool.push(P(t('AE'), t('CG'), 'Pool 5'))
    pool.push(P(t('BF'), t('DH'), 'Pool 6'))
  }
  return pool
}

// After pool completes, reseed by pool performance and build the bracket schedule using NEW letters
function buildBracketSchedule(size){
  const t = s => [s[0], s[1]]
  const B = (l1,l2,label) => ({ phase:'bracket', to:15, winBy:2, pair1:l1, pair2:l2, label })
  const BD = (from1, from2, label) => ({ phase:'bracket-derivative', to:15, winBy:2, from1, from2, label })
  const bracket = []

  if (size===4){
    bracket.push(B(t('AB'), t('CD'), 'Final'))
  }
  if (size===5){
    bracket.push(B(t('AB'), t('CD'), 'Final')) // 5th will be E by structure
  }
  if (size===6){
    bracket.push(B(t('CD'), t('EF'), 'SF'))
    // Final = AB vs Winner(SF)
    bracket.push(BD({ type:'fixedLetters', letters:t('AB') }, { type:'winnerOf', label:'SF' }, 'Final'))
  }
  if (size===7){
    bracket.push(B(t('CD'), t('EF'), 'SF'))
    bracket.push(BD({ type:'fixedLetters', letters:t('AB') }, { type:'winnerOf', label:'SF' }, 'Final'))
  }
  if (size===8){
    bracket.push(B(t('AB'), t('GH'), 'SF1'))
    bracket.push(B(t('CD'), t('EF'), 'SF2'))
    // Bronze = Loser(SF1) vs Loser(SF2); Final = Winner(SF1) vs Winner(SF2)
    bracket.push(BD({ type:'loserOf', label:'SF1' }, { type:'loserOf', label:'SF2' }, 'Bronze'))
    bracket.push(BD({ type:'winnerOf', label:'SF1' }, { type:'winnerOf', label:'SF2' }, 'Final'))
  }
  return bracket
}

// Compute pool standings (per event) from pool game results only
function computePoolStandings(poolGames){
  const table = {} // name -> {W,L,PF,PA}
  const ensure = (n)=> table[n] || (table[n] = {W:0,L:0,PF:0,PA:0})
  poolGames.forEach(g=>{
    const { team1=[], team2=[], s1=0, s2=0 } = g
    team1.forEach(n=>{ ensure(n); table[n].PF += +s1; table[n].PA += +s2 })
    team2.forEach(n=>{ ensure(n); table[n].PF += +s2; table[n].PA += +s1 })
    if (s1>s2) { team1.forEach(n=> table[n].W++); team2.forEach(n=> table[n].L++) }
    else if (s2>s1) { team2.forEach(n=> table[n].W++); team1.forEach(n=> table[n].L++) }
  })
  // Rank: Wins → (PF-PA) → PF → name
  const rows = Object.keys(table).map(n=> ({ Player:n, ...table[n] }))
  rows.sort((a,b)=>{
    if (b.W !== a.W) return b.W - a.W
    const da = (a.PF - a.PA), db = (b.PF - b.PA)
    if (db !== da) return db - da
    if (b.PF !== a.PF) return b.PF - a.PF
    return a.Player.localeCompare(b.Player)
  })
  return rows.map(r=>r.Player) // ordered names, best first
}

/** Compute placements based on bracket results + bracket letters (after reseed) */
function computePlacements(size, allResults, lettersBracket){
  const placements = { 1:[], 2:[], 3:[], 4:[], 5:[], 7:[] }

  // Helpers to fetch result objects by label
  const byLabel = (label)=> Object.values(allResults).find(r=> r.label===label)

  if (size===4){
    const final = byLabel('Final')
    if (final){ placements[1]=final.winner; placements[2]=final.loser }
    return prunePlacements(placements)
  }
  if (size===5){
    const final = byLabel('Final')
    if (final){ placements[1]=final.winner; placements[2]=final.loser }
    // 5th is E (by bracket reseed letters)
    if (lettersBracket && lettersBracket['E']) placements[5] = [lettersBracket['E']]
    return prunePlacements(placements)
  }
  if (size===6){
    const sf = byLabel('SF')
    const final = byLabel('Final')
    if (final){ placements[1]=final.winner; placements[2]=final.loser }
    if (sf){ placements[3]=sf.loser }
    return prunePlacements(placements)
  }
  if (size===7){
    const sf = byLabel('SF')
    const final = byLabel('Final')
    if (final){ placements[1]=final.winner; placements[2]=final.loser }
    if (sf){ placements[3]=sf.loser }
    // 7th = G (last seed after reseed)
    if (lettersBracket && lettersBracket['G']) placements[7] = [lettersBracket['G']]
    return prunePlacements(placements)
  }
  if (size===8){
    const bronze = byLabel('Bronze')
    const final = byLabel('Final')
    if (final){ placements[1]=final.winner; placements[2]=final.loser }
    if (bronze){ placements[3]=bronze.winner; placements[4]=bronze.loser }
    return prunePlacements(placements)
  }
  return prunePlacements(placements)
}

function prunePlacements(p){
  const out = {}
  Object.entries(p).forEach(([k,v])=>{ if (Array.isArray(v) && v.length) out[k]=v })
  return out
}

/** Resolve teams for any match entry, using appropriate letters map */
function resolveTeamsForEntry(entry, lettersPool, lettersBracket, results){
  const Lpool = lettersPool, Lbr = lettersBracket
  const namesFromLetters = (letters, useBracket) => (useBracket?letters.map(ch=>Lbr[ch]):letters.map(ch=>Lpool[ch]))

  if (entry.phase==='pool' || entry.phase==='bracket'){
    const useBracket = entry.phase==='bracket'
    return {
      team1: namesFromLetters(entry.pair1, useBracket),
      team2: namesFromLetters(entry.pair2, useBracket)
    }
  }
  if (entry.phase==='bracket-derivative'){
    const side = (from)=>{
      if (from.type==='fixedLetters') return namesFromLetters(from.letters, true)
      const base = Object.values(results).find(r=> r.label===from.label)
      if (!base) return ['(TBD)', '(TBD)']
      if (from.type==='winnerOf') return base.winner
      if (from.type==='loserOf')  return base.loser
      return ['(TBD)', '(TBD)']
    }
    return { team1: side(entry.from1), team2: side(entry.from2) }
  }
  return null
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
    const ranked = rankPlayers(list)
    return ranked.map(r => ({
      ...r,
      Games: r.Wins + r.Losses,
      PointDiff: r.PF - r.PA,
    }))
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
                  <th>Rank</th><th>Player</th><th>Points</th><th>Games</th><th>Wins</th><th>Losses</th>
                  <th>Points For</th><th>Points Against</th><th>Point Diff</th>
                  <th>Slam Wins</th><th>Signature Wins</th><th>Challenger Wins</th><th>Avg Diff</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r=> (
                  <tr key={r.Player}>
                    <td><strong>{r.Rank}</strong></td>
                    <td>{r.Player}</td>
                    <td>{r.Points}</td>
                    <td>{r.Games}</td>
                    <td>{r.Wins}</td>
                    <td>{r.Losses}</td>
                    <td>{r.PF}</td>
                    <td>{r.PA}</td>
                    <td>{r.PointDiff}</td>
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

  // Guided state machine
  const [lettersPool, setLettersPool] = useState(null)     // A.. mapped for POOL
  const [lettersBracket, setLettersBracket] = useState(null)// A.. mapped for BRACKET (reseeding)
  const [schedule, setSchedule] = useState([])             // combined: pool then bracket
  const [matchIdx, setMatchIdx] = useState(-1)             // index in combined schedule
  const [results, setResults] = useState({})               // idx -> {team1,team2,s1,s2,stage,label}
  const [games, setGames] = useState([])                   // rolling capture for ledger (with stage/label)

  // Manual placements (fallback)
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const [p3, setP3] = useState('')
  const [p4, setP4] = useState('')

  const names = useMemo(()=> roster.split(',').map(s=>s.trim()).filter(Boolean), [roster])
  const info = POINTS_TABLE[size]
  const needsThird  = Boolean(info.awards[3])
  const needsSeventh= Boolean(info.awards[7])
  const needsFifth  = Boolean(info.awards[5])

  const startGuided = () => {
    if (names.length !== size) return alert(`This event size requires exactly ${size} players in the roster`)
    const L = assignLetters(names, season, method)
    setLettersPool(L)
    const pool = buildPoolSchedule(size)
    setSchedule(pool)       // start with pools only
    setMatchIdx(0)
    setResults({})
    setLettersBracket(null) // not known until pools finish
    setGames([])
  }

  const currentMatch = matchIdx>=0 ? schedule[matchIdx] : null

  function onSubmitScore(e){
    e.preventDefault()
    if (!currentMatch) return

    // Resolve teams with appropriate letters map
    const resolved = resolveTeamsForEntry(currentMatch, lettersPool, lettersBracket, results)
    const team1 = resolved.team1, team2 = resolved.team2
    const s1 = +(e.target.s1.value||0)
    const s2 = +(e.target.s2.value||0)

    // Soft validation
    if (currentMatch.phase!=='pool'){
      if (Math.max(s1,s2) < 11 && !confirm('Bracket games are typically to 15. Continue?')) return
      if (Math.abs(s1-s2) < 2 && !confirm('Bracket games are win-by-2. Continue?')) return
    } else {
      if (Math.max(s1,s2) < 11 && !confirm('Pool games are typically to 11. Continue?')) return
    }

    const winner = s1>s2 ? team1 : team2
    const loser  = s1>s2 ? team2 : team1

    const rec = { team1, team2, s1:+s1, s2:+s2, winner, loser, stage: currentMatch.phase, label: currentMatch.label||'' }
    setResults(r => ({ ...r, [matchIdx]: rec }))
    setGames(g => [...g, rec])

    const lastIndex = schedule.length - 1

    if (matchIdx < lastIndex){
      // If just finished the last POOL game, generate bracket with reseeded letters and append
      const justFinished = matchIdx
      const hasBracketAlready = schedule.some(m=> m.phase!=='pool')
      const allPoolsEntered = !schedule.slice(0).some((m, idx)=> m.phase==='pool' && idx<=justFinished && !(idx===justFinished || Object.prototype.hasOwnProperty.call(results, idx)))

      if (!hasBracketAlready && allPoolsEntered){
        // Compute pool standings from recorded pool games
        const poolGames = [...Object.values({ ...results, [matchIdx]: rec })].filter(x=> x.stage==='pool')
        const orderedNames = computePoolStandings(poolGames) // best → worst
        const letters = {}
        const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
        orderedNames.forEach((name, i)=> letters[alpha[i]] = name)
        setLettersBracket(letters)

        // Append bracket schedule using reseeded letters
        const br = buildBracketSchedule(size)
        setSchedule(prev => [...prev, ...br])
      }

      setMatchIdx(matchIdx + 1)
    } else {
      // Event finished → compute placements and save (ensure last game is included)
      const finalGames = [...games, rec]
      const placements = computePlacements(size, { ...results, [matchIdx]: rec }, lettersBracket || lettersPool)
      onAdd({ size, placements, gameStats: finalGames })
      // Reset guided state
      setMatchIdx(-1); setSchedule([]); setResults({}); setLettersPool(null); setLettersBracket(null); setGames([])
    }
  }

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
              <label>Seeding Method for Pool Letters</label>
              <select value={method} onChange={e=>setMethod(e.target.value)}>
                <option value="standings">Use current standings</option>
                <option value="random">Randomize (Week 1 / newcomers)</option>
              </select>
            </div>
            <div className="row" style={{gap:8}}>
              <button className="btn" onClick={startGuided}>Start Guided Matchday</button>
            </div>

            {/* Pool letter assignments */}
            {lettersPool && (
              <div className="card" style={{border:'1px dashed #e5e7eb'}}>
                <strong>Pool Letters:</strong>
                <div className="row" style={{gap:12, flexWrap:'wrap', marginTop:8}}>
                  {Object.entries(lettersPool).map(([k,v])=> (<span key={k}><strong>{k}</strong>= {v}</span>))}
                </div>
              </div>
            )}

            {/* Bracket letters after reseed */}
            {lettersBracket && (
              <div className="card" style={{border:'1px dashed #e5e7eb'}}>
                <strong>Bracket Letters (after pool reseed):</strong>
                <div className="row" style={{gap:12, flexWrap:'wrap', marginTop:8}}>
                  {Object.entries(lettersBracket).map(([k,v])=> (<span key={k}><strong>{k}</strong>= {v}</span>))}
                </div>
              </div>
            )}

            {/* Current match prompt */}
            {matchIdx>=0 && (
              <GuidedMatchPrompt
                entry={currentMatch}
                lettersPool={lettersPool}
                lettersBracket={lettersBracket}
                results={results}
                onSubmit={onSubmitScore}
                matchIdx={matchIdx}
                total={schedule.length}
              />
            )}

            {/* Live log of all matches this event */}
            {games.length>0 && (
              <div className="card">
                <strong>Logged Matches (this event)</strong>
                <table style={{marginTop:8, width:'100%'}}>
                  <thead>
                    <tr><th>#</th><th>Stage</th><th>Label</th><th>Team 1</th><th>Team 2</th><th>Score</th></tr>
                  </thead>
                  <tbody>
                    {games.map((g,i)=> (
                      <tr key={i}>
                        <td>{i+1}</td>
                        <td>{g.stage}</td>
                        <td>{g.label}</td>
                        <td>{g.team1.join(' & ')}</td>
                        <td>{g.team2.join(' & ')}</td>
                        <td>{g.s1}–{g.s2}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {!guided && (
          <ManualPlacements size={size} onAdd={onAdd} names={names} />
        )}
      </div>

      {/* datalist for quick type-ahead */}
      <datalist id="rosterlist">
        {names.map(n=> <option key={n} value={n} />)}
      </datalist>
    </section>
  )
}

function GuidedMatchPrompt({ entry, lettersPool, lettersBracket, results, onSubmit, matchIdx, total }){
  const resolved = resolveTeamsForEntry(entry, lettersPool, lettersBracket, results)
  const label = entry.label || (entry.phase==='pool' ? `Pool` : 'Bracket')
  return (
    <form onSubmit={onSubmit} className="card" style={{marginTop:12}}>
      <div className="row" style={{justifyContent:'space-between'}}>
        <strong>Match {matchIdx+1} of {total} — {label}</strong>
        <span className="muted">{entry.phase==='pool' ? 'to 11, win by 1' : 'to 15, win by 2'}</span>
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

function ManualPlacements({ size, onAdd, names }){
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const [p3, setP3] = useState('')
  const [p4, setP4] = useState('')
  const [games, setGames] = useState([])

  return (
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

      <div>
        <div className="muted">Optional: enter game scores to accumulate Wins/Losses & PF/PA</div>
        <button type="button" className="btn" onClick={()=>setGames(g=>[...g, { team1:["",""], team2:["",""], s1:11, s2:8, stage:'manual', label:'' }])}>Add Game</button>
      </div>

      {games.map((g,idx)=> (
        <div key={idx} className="grid" style={{gridTemplateColumns:"repeat(12, 1fr)", gap:8}}>
          <input list="rosterlist" value={g.team1?.[0]||''} onChange={e=>setGames(arr=>arr.map((row,i)=> i===idx? { ...row, team1:[e.target.value, row.team1?.[1]||''] } : row))} placeholder="Team1 P1" />
          <input list="rosterlist" value={g.team1?.[1]||''} onChange={e=>setGames(arr=>arr.map((row,i)=> i===idx? { ...row, team1:[row.team1?.[0]||'', e.target.value] } : row))} placeholder="Team1 P2" />
          <input list="rosterlist" value={g.team2?.[0]||''} onChange={e=>setGames(arr=>arr.map((row,i)=> i===idx? { ...row, team2:[e.target.value, row.team2?.[1]||''] } : row))} placeholder="Team2 P1" />
          <input list="rosterlist" value={g.team2?.[1]||''} onChange={e=>setGames(arr=>arr.map((row,i)=> i===idx? { ...row, team2:[row.team2?.[0]||'', e.target.value] } : row))} placeholder="Team2 P2" />
          <input type="number" min="0" value={g.s1} onChange={e=>setGames(arr=>arr.map((row,i)=> i===idx? { ...row, s1:+e.target.value } : row))} />
          <input type="number" min="0" value={g.s2} onChange={e=>setGames(arr=>arr.map((row,i)=> i===idx? { ...row, s2:+e.target.value } : row))} />
        </div>
      ))}

      <button className="btn primary" onClick={(e)=>{
        e.preventDefault()
        if (!p1||!p2||!p3||!p4) return alert('Please fill 1st and 2nd pairs (two players each).')
        const placements = { 1:[p1,p2], 2:[p3,p4] }
        // Add last-place awards if applicable (5th/7th) based on remaining roster
        if (POINTS_TABLE[size].awards[5]) {
          const remaining = names.find(n=> ![p1,p2,p3,p4].includes(n))
          if (remaining) placements[5] = [remaining]
        }
        if (POINTS_TABLE[size].awards[7]) {
          const others = names.filter(n=> ![p1,p2,p3,p4].includes(n))
          if (others.length) placements[7] = [others[others.length-1]] // rough fallback
        }
        onAdd({ size, placements, gameStats: games })
      }}>Add Event to Standings</button>
    </div>
  )
}

function HistoryView({ events, onDelete }){
  return (
    <section className="card">
      <h2 style={{marginTop:0}}>Event History</h2>
      {!events.length && <p className="muted">No events yet.</p>}
      {!!events.length && (
        <>
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

          {/* Full games log per event */}
          {events.map((ev, idx)=> (
            <div key={`glog-${ev.id}`} className="card" style={{marginTop:12}}>
              <strong>Event {idx+1} — Games Log</strong>
              {!ev.gameStats?.length && <p className="muted">(No individual games recorded for this event)</p>}
              {!!ev.gameStats?.length && (
                <table style={{marginTop:8, width:'100%'}}>
                  <thead>
                    <tr><th>#</th><th>Stage</th><th>Label</th><th>Team 1</th><th>Team 2</th><th>Score</th></tr>
                  </thead>
                  <tbody>
                    {ev.gameStats.map((g,i)=> (
                      <tr key={i}>
                        <td>{i+1}</td>
                        <td>{g.stage || ''}</td>
                        <td>{g.label || ''}</td>
                        <td>{(g.team1||[]).join(' & ')}</td>
                        <td>{(g.team2||[]).join(' & ')}</td>
                        <td>{g.s1}–{g.s2}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </>
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
            s1:+r[4], s2:+r[5], stage:'', label:''
          }))
          let placements = {}
          if (size===4) {
            const f = gameStats[gameStats.length-1]
            const champs  = f.s1>f.s2 ? f.team1 : f.team2
            const runners = f.s1>f.s2 ? f.team2 : f.team1
            placements = { 1: champs, 2: runners }
          } else if (size===8) {
            const last4 = gameStats.slice(-4)
            const final = last4[last4.length-1]
            const bronze = last4[last4.length-2]
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
