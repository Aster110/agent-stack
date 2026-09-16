#!/usr/bin/env node
import fs from 'node:fs'
import {migrateLegacyBrain} from '../packages/agent-runtime/dist/migrate.js'
if(process.argv.length!==3)throw new Error('Usage: node scripts/migrate-tmux-brain.mjs /private/migration.json')
console.log(JSON.stringify(migrateLegacyBrain(JSON.parse(fs.readFileSync(process.argv[2],'utf8')))))
