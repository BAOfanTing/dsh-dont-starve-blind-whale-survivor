// 强制提交信息遵循 Conventional Commits：type(scope): subject 或 type: subject（scope 可选）。
// 当提供 scope 时，必须是下表中的模块域之一；type 由 @commitlint/config-conventional 约束。
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-empty': [0],
    'scope-enum': [
      2,
      'always',
      ['bridge', 'control', 'planner', 'skills', 'lua', 'dsh', 'autodev', 'docs', 'ci', 'test', 'chore'],
    ],
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
}
