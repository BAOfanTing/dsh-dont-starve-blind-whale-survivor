// 强制提交信息遵循 type(scope): subject —— 与仓库既有风格一致（如 fix(runtime): / feat(reflex): / docs(rules):）。
// 说明：scope 必填（本仓库每条提交都带作用域）。type 由 @commitlint/config-conventional 约束。
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-empty': [2, 'never'],        // 必须有 scope
    'subject-case': [0],                // 中文/任意大小写不限制
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
}
