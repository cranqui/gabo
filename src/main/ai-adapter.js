// src/main/ai-adapter.js
// Streaming SSE adapter for OpenAI-compatible chat completions endpoints
// Works with Ollama, OpenAI, Groq, Together, OpenRouter, Hermes, etc.
const https = require('https')
const http = require('http')

/**
 * Stream chat completions from an OpenAI-compatible API.
 * Yields chunks of text as they arrive via callbacks.
 *
 * @param {Object} options
 * @param {string} options.baseURL  - e.g. "http://localhost:11434/v1"
 * @param {string} options.apiKey   - Bearer token (empty for Ollama)
 * @param {string} options.model    - e.g. "llama3.2"
 * @param {Array}  options.messages - [{ role, content }]
 * @param {number} options.temperature
 * @param {number} options.maxTokens
 * @param {AbortSignal} options.signal - AbortController signal to cancel the request
 * @param {Function} options.onChunk - called with each text delta
 * @param {Function} options.onDone - called when stream ends (guaranteed once)
 * @param {Function} options.onError - called on error
 */
async function streamChat({ baseURL, apiKey, model, messages, temperature, maxTokens, signal, onChunk, onDone, onError }) {
  // Ensure baseURL ends with / so new URL('chat/completions', ...) works correctly
  const normalizedBase = baseURL.endsWith('/') ? baseURL : baseURL + '/'
  const url = new URL('chat/completions', normalizedBase)
  const isHttps = url.protocol === 'https:'
  const transport = isHttps ? https : http

  const body = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: true
  })

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream'
  }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const reqOptions = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(reqOptions, (res) => {
      // Reject non-2xx responses before processing the stream
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let body = ''
        res.on('data', (chunk) => { body += chunk.toString() })
        res.on('end', () => {
          let message = `HTTP ${res.statusCode}`
          try {
            const json = JSON.parse(body)
            message += `: ${json.error?.message || json.message || json.error || body.slice(0, 200)}`
          } catch {
            message += `: ${body.slice(0, 200)}`
          }
          const err = new Error(message)
          err.status = res.statusCode
          onError?.(err)
          reject(err)
        })
        return
      }

      let buffer = ''
      let done = false  // Guard against onDone firing twice (data: [DONE] + res 'end')

      // If aborted, destroy the response
      if (signal?.aborted) {
        res.destroy()
        return
      }

      res.on('data', (chunk) => {
        if (signal?.aborted) {
          res.destroy()
          return
        }
        buffer += chunk.toString()
        // SSE lines are separated by \n\n
        const lines = buffer.split('\n')
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(':')) continue  // skip comments/keepalives
          if (trimmed === 'data: [DONE]') {
            if (!done) {
              done = true
              onDone?.()
            }
            resolve()
            return
          }
          if (trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.slice(6))
              const content = json.choices?.[0]?.delta?.content
              if (content) {
                onChunk(content)
              }
            } catch (e) {
              // Incomplete JSON in stream — skip, will be parsed next cycle
            }
          }
        }
      })

      res.on('end', () => {
        if (!done) {
          done = true
          onDone?.()
        }
        resolve()
      })

      res.on('error', (err) => {
        if (!done) {
          done = true
          onError?.(err)
          reject(err)
        }
      })
    })

    req.on('error', (err) => {
      // Don't forward aborted requests — the catch block in main.js handles that
      if (err.message === 'Request aborted') { resolve(); return }
      reject(err)
    })

    // Wire up AbortController — abort the HTTP request if signalled
    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy(new Error('Request aborted'))
      }, { once: true })
    }

    req.write(body)
    req.end()
  })
}

module.exports = { streamChat }