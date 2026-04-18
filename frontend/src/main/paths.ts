/**
 * Central path configuration. All lineup data (db, virtual projects,
 * config) lives under a single root directory.
 *
 * Default: ~/.lineup
 * Override: set LINEUP_DATA_DIR environment variable before launching.
 *
 * This is useful for:
 *   - Running a demo/sandbox instance without touching real data
 *   - Multiple isolated lineup installs (work vs personal)
 *   - Tests
 *
 * Example: LINEUP_DATA_DIR=/tmp/lineup-demo npm run dev
 */

import { join } from 'path'
import { homedir } from 'os'

export const LINEUP_HOME = process.env.LINEUP_DATA_DIR
  ? process.env.LINEUP_DATA_DIR
  : join(homedir(), '.lineup')

export const DB_PATH = join(LINEUP_HOME, 'lineup.db')
export const WAL_PATH = join(LINEUP_HOME, 'lineup.db-wal')
export const VIRTUAL_PROJECTS_ROOT = join(LINEUP_HOME, 'projects')
export const SHARED_MCP_PATH = join(LINEUP_HOME, '.mcp.json')
