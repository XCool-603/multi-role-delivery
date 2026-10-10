// 多角色组队交付 —— workflow 工具编排骨架（用户终审版）
//
// 用法：把本文件内容作为 workflow 工具的 `script` 传入。
//
//   mode: 'initial'  （默认）首次并行开工
//     args = { mode:'initial', task, taskDir, criteria:[...], roles:[...], gateRounds }
//
//   mode: 'rework'   用户说不满意之后，把他的话变成返工
//     args = { mode:'rework', task, taskDir, criteria, roles, userFeedback, startRound, gateRounds }
//
// 注意：workflow 脚本内没有 fs / network / timer，所有文件读写都由子代理完成。
//       脚本只负责：并行调度、把用户意见分诊、内部初筛门、汇总。
//       用户的满意度问询由主代理负责——脚本碰不到用户。

const mode = args.mode || 'initial';
const task = args.task;
const taskDir = args.taskDir;
const criteria = args.criteria || [];
const roles = args.roles || [];          // [{ name, goal, inputs, deliverable, acceptance, boundaries }]
const userFeedback = args.userFeedback || '';
const gateRounds = args.gateRounds || 3; // 内部初筛最多几轮（初筛只是挡明显不合格的，不追求完美）
let startRound = args.startRound || 1;

// ---------------------------------------------------------------- schema

const ROLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['role', 'status', 'artifacts', 'summary', 'self_check'],
  properties: {
    role: { type: 'string' },
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'what'],
        properties: { path: { type: 'string' }, what: { type: 'string' } }
      }
    },
    summary: { type: 'string' },
    evidence: { type: 'string' },
    self_check: { type: 'string' },
    open_questions: { type: 'string' }
  }
};

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'criteria', 'blocking'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'met', 'evidence'],
        properties: {
          criterion: { type: 'string' },
          met: { type: 'boolean' },
          evidence: { type: 'string' }
        }
      }
    },
    blocking: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'severity', 'where', 'why', 'how_to_fix', 'owner_role', 'evidence'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          where: { type: 'string' },
          why: { type: 'string' },
          how_to_fix: { type: 'string' },
          owner_role: { type: 'string' },
          evidence: { type: 'string' }
        }
      }
    },
    non_blocking: { type: 'string' },
    notes: { type: 'string' }
  }
};

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['understanding', 'global_redo', 'issues'],
  properties: {
    understanding: { type: 'string' },
    global_redo: { type: 'boolean' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'what', 'why', 'how_to_fix', 'owner_role', 'severity'],
        properties: {
          id: { type: 'string' },
          what: { type: 'string' },
          why: { type: 'string' },
          how_to_fix: { type: 'string' },
          owner_role: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] }
        }
      }
    },
    unclear: { type: 'string' }
  }
};

// ---------------------------------------------------------------- prompts

function roleCard(role) {
  return [
    `- 角色名：${role.name}`,
    `- 目标：${role.goal}`,
    `- 输入：${role.inputs}`,
    `- 交付物（必须落盘到这个路径）：${role.deliverable}`,
    `- 你负责的验收标准：${role.acceptance}`,
    `- 边界（不要做的事）：${role.boundaries}`
  ].join('\n');
}

const COMMON_RULES = [
  '工作规则：',
  '1. 必须把真实产物写到你负责的交付路径下，不要只在回复里描述。',
  '2. 完成后自己按验收标准自检一遍，把自检结论写进 self_check。',
  '3. 如实报告。做不到、做不全、有疑问，就在 status 里标 partial/blocked 并写进 open_questions。',
  '4. 禁止假装完成——如实报告 partial 比谎报 done 有价值得多。',
  '5. 不要改别人的交付物，越界改动会破坏其他人的工作。',
  '6. 用中文回复。'
].join('\n');

function issuesBlock(issues) {
  if (!issues || !issues.length) return '';
  return issues
    .map(i => `- [${i.id}/${i.severity}] ${i.where || i.what}\n  问题：${i.why || i.what}\n  怎么修：${i.how_to_fix}\n  证据：${i.evidence || '（用户意见）'}`)
    .join('\n');
}

function rolePrompt(role, round, issues) {
  const rework = issues && issues.length
    ? ['', `这是第 ${round} 轮返工。以下问题属于你的范围，逐条修掉：`, issuesBlock(issues)].join('\n')
    : '';
  return [
    `你是「${role.name}」，一个多角色协作交付团队中的一员。`,
    '',
    `总任务：${task}`,
    `任务目录：${taskDir}`,
    '',
    '你的角色卡：',
    roleCard(role),
    rework,
    '',
    COMMON_RULES
  ].join('\n');
}

function reviewPrompt(round) {
  return [
    '你是这个交付团队里的产品/QA 初筛人。你不是任何一件交付物的产出者，你的职责就是独立挑毛病。',
    '',
    `总任务：${task}`,
    `任务目录：${taskDir}`,
    `这是第 ${round} 轮初筛。`,
    '',
    '验收标准（逐条核对，一条都不能漏）：',
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    '',
    '角色与交付物：',
    ...roles.map(r => `- ${r.name} → ${r.deliverable}`),
    '',
    '要求：',
    '1. 自己去读盘上的真实产物、真跑命令验证。不要相信任何人的自述总结。',
    '2. 默认去找真缺陷，不要走过场式地给通过。',
    '3. 每一条阻塞项必须带具体证据：文件加行号、命令输出、或复现步骤。',
    '4. 没有证据的猜测不算阻塞项，宁可不报也不要编造。',
    '5. 阻塞项要给出 owner_role，指明该由哪个角色修。',
    '6. 把本轮报告写到 ' + taskDir + '/review/round-' + round + '.md。',
    '7. 用中文。',
    '',
    '判定：全部验收标准达成且没有阻塞项才给 pass，否则 fail。'
  ].join('\n');
}

function triagePrompt(round) {
  return [
    '你是交付团队的接口人。用户刚看了交付的版本，表达了不满。',
    '',
    `总任务：${task}`,
    `任务目录：${taskDir}`,
    '',
    '用户的原话（可能很口语、很模糊）：',
    '"""',
    userFeedback,
    '"""',
    '',
    '团队现有角色：',
    ...roles.map(r => `- ${r.name}：${r.goal}`),
    '',
    '你的任务：把用户的大白话翻译成结构化的返工项。',
    '',
    '要求：',
    '1. 先自己去看盘上的真实产物，理解他到底在说什么。不要凭空猜。',
    '2. 每条问题写成可执行的返工项：what（是什么）/ why（为什么是问题）/ how_to_fix（怎么改）/ owner_role（归哪个角色）/ severity。',
    '3. owner_role 必须是上面列出的角色之一。没有合适的就写"未归属"。',
    '4. 判断范围：如果用户指的是具体某处，global_redo 填 false；如果是整体性意见（"感觉不对""不如预期""整体不好"），global_redo 填 true —— 整体感受通常代表一类问题，只修一处一定还会被退。',
    '5. 如果用户的话实在无法理解，把疑问写进 unclear，不要编造。',
    '6. 把「用户原话 + 你的翻译」写到 ' + taskDir + '/feedback/round-' + round + '.md。',
    '7. 用中文。'
  ].join('\n');
}

// ---------------------------------------------------------------- 阶段A：把用户意见变成返工项

let triage = null;
let scope = 'initial';

if (mode === 'rework') {
  phase('理解你的意见');
  triage = await agent(triagePrompt(startRound), {
    label: '意见分诊',
    phase: '理解你的意见',
    schema: TRIAGE_SCHEMA
  });

  scope = triage && triage.global_redo ? 'global' : 'targeted';
  log(`用户意见已分诊：${triage ? triage.issues.length : 0} 条返工项，范围=${scope}`);

  const byOwner = {};
  if (scope === 'global') {
    // 整体性意见 → 全体返工，每个角色都拿到全部意见作为上下文
    for (const r of roles) byOwner[r.name] = (triage && triage.issues) || [];
  } else {
    for (const issue of (triage && triage.issues) || []) {
      const key = issue.owner_role || '未归属';
      (byOwner[key] = byOwner[key] || []).push(issue);
    }
  }

  const owners = Object.keys(byOwner).map(name => {
    const role = roles.find(r => r.name === name) || {
      name,
      goal: '修复用户指出的问题',
      inputs: '见返工项描述',
      deliverable: `${taskDir}/work/${name}/`,
      acceptance: '分配给你的返工项全部修复',
      boundaries: '只改与返工项相关的部分，不要动无关交付物'
    };
    return { role, issues: byOwner[name] };
  });

  phase('返工');
  log(`返工：${owners.map(o => o.role.name).join('、')}`);

  await pipeline(owners, async (_prev, o) =>
    agent(rolePrompt(o.role, startRound, o.issues), {
      label: `返工 ${o.role.name}`,
      phase: '返工',
      schema: ROLE_SCHEMA
    })
  );
}

// ---------------------------------------------------------------- 阶段B：首次并行开工

if (mode === 'initial') {
  phase('并行干活');
  log(`开工：${roles.length} 个角色并行，任务目录 ${taskDir}`);

  const first = await pipeline(roles, async (_prev, role) =>
    agent(rolePrompt(role, 1, []), {
      label: role.name,
      phase: '并行干活',
      schema: ROLE_SCHEMA
    })
  );

  const done = first.filter(Boolean);
  log(`首轮完成 ${done.length}/${roles.length} 个角色`);
}

// ---------------------------------------------------------------- 阶段C：内部初筛门

let round = startRound;
let verdict = null;
const history = [];

while (round < startRound + gateRounds) {
  phase(`产品初筛 第${round}轮`);

  verdict = await agent(reviewPrompt(round), {
    label: `产品初筛 R${round}`,
    phase: `产品初筛 第${round}轮`,
    schema: REVIEW_SCHEMA
  });

  if (!verdict) {
    log(`第 ${round} 轮初筛代理失败，停止循环`);
    break;
  }

  const n = (verdict.blocking || []).length;
  history.push({ round, verdict: verdict.verdict, blocking: n });
  log(`第 ${round} 轮初筛：${verdict.verdict}，阻塞项 ${n} 个`);

  if (verdict.verdict === 'pass') break;
  if (round >= startRound + gateRounds - 1) {
    log('初筛轮数用尽，带已知问题交付（初筛只挡明显不合格，不追求完美）');
    break;
  }

  // 初筛发现的阻塞项 → 路由回责任角色
  const byOwner = {};
  for (const issue of verdict.blocking || []) {
    const key = issue.owner_role || '未归属';
    (byOwner[key] = byOwner[key] || []).push(issue);
  }
  const owners = Object.keys(byOwner).map(name => {
    const role = roles.find(r => r.name === name) || {
      name,
      goal: '修复初筛发现的阻塞项',
      inputs: '见阻塞项描述',
      deliverable: `${taskDir}/work/${name}/`,
      acceptance: '分配给你的阻塞项均已修复',
      boundaries: '只修分配给你的问题'
    };
    return { role, issues: byOwner[name] };
  });

  phase(`初筛返工 第${round}轮`);
  await pipeline(owners, async (_prev, o) =>
    agent(rolePrompt(o.role, round, o.issues), {
      label: `初筛返工 ${o.role.name}`,
      phase: `初筛返工 第${round}轮`,
      schema: ROLE_SCHEMA
    })
  );

  round++;
}

// ---------------------------------------------------------------- 汇总

const passed = !!(verdict && verdict.verdict === 'pass');

return {
  mode,
  scope,
  gatePassed: passed,
  gateRound: round,
  taskDir,
  roles: roles.map(r => r.name),
  history,
  understanding: triage ? triage.understanding : '',
  unclear: triage ? triage.unclear || '' : '',
  triageIssues: triage ? triage.issues : [],
  blocking: verdict && verdict.blocking ? verdict.blocking : [],
  criteria: verdict && verdict.criteria ? verdict.criteria : [],
  nonBlocking: verdict && verdict.non_blocking ? verdict.non_blocking : ''
};
