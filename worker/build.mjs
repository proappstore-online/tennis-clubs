import { copyFile, mkdir } from 'node:fs/promises'

await mkdir('dist', { recursive: true })
await copyFile('src/app.js', 'dist/app.js')
console.log('built dist/app.js')
