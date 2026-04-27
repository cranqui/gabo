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
 * @param {Function} options.onChunk - called with each text delta
 * @param {Function} options.onDone - called when stream ends
 * @param {Function} options.onError - called on error
 */
async function streamChat({ baseURL, apiKey, model, messages, temperature, maxTokens, onChunk, onDone, onError }) {
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
      let buffer = ''

      res.on('data', (chunk) => {
        buffer += chunk.toString()
        // SSE lines are separated by \n\n
        const lines = buffer.split('\n')
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(':')) continue  // skip comments/keepalives
          if (trimmed === 'data: [DONE]') {
            onDone?.()
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
        onDone?.()
        resolve()
      })

      res.on('error', (err) => {
        onError?.(err)
        reject(err)
      })
    })

    req.on('error', (err) => {
      onError?.(err)
      reject(err)
    })

    req.write(body)
    req.end()
  })
}

module.exports = { streamChat }