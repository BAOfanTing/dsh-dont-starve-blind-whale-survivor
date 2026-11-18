import http from 'node:http'
import { EventEmitter } from 'node:events'

export class HttpServer extends EventEmitter {
  constructor(port = 0, token = '') {
    super()
    this.port = port
    this.token = token
    this.server = http.createServer((req, res) => {
      let url
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1')
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'bad_url' }))
        return
      }

      // 提取 token（Query 参数优先）
      const queryToken = url.searchParams.get('t')
      if (this.token && queryToken && queryToken !== this.token) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/exchange') {
        const chunks = []
        let bytes = 0
        req.on('data', (chunk) => {
          bytes += chunk.length
          if (bytes > 1024 * 1024) { // 限制 1MB 保护
            req.destroy()
            return
          }
          chunks.push(chunk)
        })

        req.on('end', () => {
          let payload = null
          if (chunks.length > 0) {
            try {
              const text = Buffer.concat(chunks).toString('utf8')
              if (text.trim()) payload = JSON.parse(text)
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_json' }))
              return
            }
          }

          const effectiveToken = queryToken || (payload?.token ? String(payload.token) : null)
          if (this.token && effectiveToken !== this.token) {
            res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
            return
          }

          let replied = false
          const reply = (data) => {
            if (replied) return
            replied = true
            const jsonStr = JSON.stringify(data ?? {})
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': Buffer.byteLength(jsonStr),
              'Cache-Control': 'no-store',
              'Connection': 'close',
            })
            res.end(jsonStr)
          }

          if (this.listenerCount('exchange') > 0) {
            this.emit('exchange', payload ?? {}, reply)
          } else {
            reply({ ok: true })
          }
        })
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }))
    })

    // 设置超时与连接池
    this.server.keepAliveTimeout = 5000
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.off('error', reject)
        this.server.unref() // 防止阻塞测试或进程退出
        const addr = this.server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : this.port
        resolve(this.port)
      })
    })
  }

  close() {
    try {
      this.server.closeAllConnections?.()
    } catch {}
    return new Promise((resolve) => {
      this.server.close(() => resolve())
    })
  }
}
