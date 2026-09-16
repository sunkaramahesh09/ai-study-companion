// Load .env for integration tests. Node 26 has this built in, so no dotenv.
// Missing file is fine: unit tests don't need it and CI injects real env vars.
import { existsSync } from 'node:fs';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
