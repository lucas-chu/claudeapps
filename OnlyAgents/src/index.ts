import { loadConfig } from './config.js'
import { createApp } from './server.js'

const config = loadConfig(process.env)
const app = createApp(config)

app.listen(config.port, () => {
  console.log(`  OnlyAgents ready on http://localhost:${config.port}`)
  if (config.ephemeralSecret) {
    console.log(
      '  ONLYAGENTS_SECRET not set — generated a per-process secret. ' +
        'Restarting invalidates every chain in flight.',
    )
  }
})
