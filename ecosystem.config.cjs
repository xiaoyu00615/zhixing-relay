module.exports = {
  apps: [
    {
      name: "zhixing-relay",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/index.ts",
      cwd: "D:\\Workspace\\object\\zhixing-relay",
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      watch: false
    }
  ]
}