// 多角色组队交付 —— workflow 工具编排骨架
//
// 用法：把本文件内容作为 workflow 工具的 `script` 传入，
//       args = { task, taskDir, criteria: [...], roles: [...], maxRounds }
//
// 注意：workflow 脚本内没有 fs / network / timer，所有文件读写都由子代理完成。
//       脚本只负责：并行调度、验收门、返工循环、汇总。

const task = args.task;
const taskDir = args.taskDir;
const criteria = args.criteria || [];
const roles = args.roles || [];        // [{ name, goal, inputs, deliverable, acceptance, boundaries }]
const maxRounds = args.maxRounds || 8;

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
        properties: {
          path: { type: 'string' },
          what: { type: 'string' }
        }
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

function rolePrompt(role, round, issues) {
  const rework = issues && issues.length
    ? [
        '',
        `这是第 ${round} 轮返工。上一轮产品验收发现了以下属于你的阻塞项，逐条修掉：`,
        ...issues.map(i => `- [${i.id}/${i.severity}] ${i.where}\n  问题：${i.why}\n  怎么修：${i.how_to_fix}\n  证据：${i.evidence}`)
      ].join('\n')
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
    '你是这个交付团队里的产品/QA 验收人。你不是任何一件交付物的产出者，你的职责就是独立挑毛病。',
    '',
    `总任务：${task}`,
    `任务目录：${taskDir}`,
    `这是第 ${round} 轮验收。`,
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

// ---------------------------------------------------------------- 阶段1：并行干活

phase('并行干活');
log(`开工：${roles.length} 个角色并行，任务目录 ${taskDir}`);

const firstPass = await pipeline(roles, async (_prev, role) =>
  agent(rolePrompt(role, 1, []), {
    label: role.name,
    phase: '并行干活',
    schema: ROLE_SCHEMA
  })
);

const done = firstPass.filter(Boolean);
log(`首轮完成 ${done.length}/${roles.length} 个角色`);

// ---------------------------------------------------------------- 阶段2/3：验收 + 返工

let round = 1;
let verdict = null;
let prevBlocking = Infinity;
let plateau = false;
let history = [];

while (round <= maxRounds) {
  phase(`产品验收 第${round}轮`);

  verdict = await agent(reviewPrompt(round), {
    label: `产品验收 R${round}`,
    phase: `产品验收 第${round}轮`,
    schema: REVIEW_SCHEMA
  });

  if (!verdict) {
    log(`第 ${round} 轮验收代理失败，停止循环`);
    break;
  }

  const n = (verdict.blocking || []).length;
  history.push({ round, verdict: verdict.verdict, blocking: n });
  log(`第 ${round} 轮：${verdict.verdict}，阻塞项 ${n} 个`);

  if (verdict.verdict === 'pass') break;

  // 平台期保护：连续两轮阻塞项没下降就停，别无限烧
  if (n >= prevBlocking) {
    plateau = true;
    log(`平台期：第 ${round} 轮阻塞项 ${n} 个，较上轮未下降 → 停止返工，升级给用户`);
    break;
  }
  prevBlocking = n;

  if (round >= maxRounds) break;

  // 按 owner_role 分组，只重跑受影响的工作流
  const byOwner = {};
  for (const issue of verdict.blocking || []) {
    const key = issue.owner_role || '未归属';
    (byOwner[key] = byOwner[key] || []).push(issue);
  }

  const owners = Object.keys(byOwner).map(name => {
    const role = roles.find(r => r.name === name) || {
      name,
      goal: '修复验收发现的阻塞项',
      inputs: '见阻塞项描述',
      deliverable: `${taskDir}/work/${name}/`,
      acceptance: '所有分配给你的阻塞项均已修复',
      boundaries: '只修分配给你的问题，不要改动其他角色的交付物'
    };
    return { role, issues: byOwner[name] };
  });

  phase(`返工 第${round}轮`);
  log(`返工：${owners.map(o => o.role.name).join('、')}`);

  await pipeline(owners, async (_prev, o) =>
    agent(rolePrompt(o.role, round, o.issues), {
      label: `返工 ${o.role.name}`,
      phase: `返工 第${round}轮`,
      schema: ROLE_SCHEMA
    })
  );

  round++;
}

// ---------------------------------------------------------------- 汇总

const passed = !!(verdict && verdict.verdict === 'pass');

return {
  passed,
  plateau,
  rounds: round,
  taskDir,
  roles: roles.map(r => r.name),
  history,
  blocking: verdict && verdict.blocking ? verdict.blocking : [],
  criteria: verdict && verdict.criteria ? verdict.criteria : [],
  nonBlocking: verdict && verdict.non_blocking ? verdict.non_blocking : ''
};
