import { LEVELS } from '../dist/src/levels.js';
import { createInitialState, runScript, solve, stateKey, step } from '../dist/src/engine.js';

const only = process.argv[2];

for (const level of LEVELS) {
  if (only && level.id !== only) continue;
  console.log(`\n=== ${level.id}: ${level.name} ===`);
  const initial = createInitialState(level);
  console.log('start', initial.pos, 'doors', initial.doors);
  const solved = solve(level);
  console.log('solve', solved.status, 'reached', solved.reachedStates, 'path', solved.status === 'won' ? solved.path.join('') : '-');
  if (solved.status !== 'won') console.log(solved.diagnosis);

  for (const name of ['win', 'dead']) {
    const script = level.replay[name];
    if (!script) continue;
    const run = runScript(level, script);
    console.log(`script ${name}: ${script} -> won=${run.won}, turns=${run.states.length - 1}`);
    run.infos.forEach((info, i) => {
      const s = run.states[i + 1];
      console.log(
        i + 1,
        info.dir,
        'moved',
        JSON.stringify(info.moved),
        'blocked',
        JSON.stringify(info.blockedReason),
        'pos',
        JSON.stringify(s.pos),
        'doors',
        JSON.stringify(s.doors),
        'used',
        JSON.stringify(s.used),
        'events',
        info.events.map((e) => e.type).join(','),
      );
    });
    const end = run.states.at(-1);
    const fromEnd = solve(level, end);
    console.log('from script end:', fromEnd.status, fromEnd.status === 'won' ? fromEnd.path.join('') : fromEnd.diagnosis.kind);
  }
}
