import express from 'express'
import cors from 'cors'
import Anthropic from '@anthropic-ai/sdk'
import { chromium } from 'playwright'

const app = express()
app.use(cors())
app.use(express.json())

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

let browser = null

async function getBrowser() {
  if (browser && browser.isConnected()) return browser
  browser = await chromium.launch({ args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] })
  return browser
}

app.get('/polygons', async (req, res) => {
  const { south, west, north, east, zoom } = req.query
  if (!south || !west || !north || !east) return res.status(400).json({ error: 'Missing bbox params' })
  const centerLat = (parseFloat(north) + parseFloat(south)) / 2
  const centerLng = (parseFloat(east) + parseFloat(west)) / 2
  let page = null
  try {
    const b = await getBrowser()
    page = await b.newPage()
    await page.setViewportSize({ width: 1280, height: 800 })
    const url = 'https://minasidor.parkeringgoteborg.se/sv/hitta-parkering?lat=' + centerLat + '&lng=' + centerLng + '&zoom=' + (zoom || 16)
    console.log('Navigating to: ' + url)
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(3000)
    try { await page.keyboard.press('Escape'); await page.waitForTimeout(500) } catch {}
    const screenshot = await page.screenshot({ type: 'png', fullPage: false })
    const base64Image = screenshot.toString('base64')
    const prompt = 'You are analyzing a screenshot of a parking map from Parkering Goteborg. South: ' + south + ', North: ' + north + ', West: ' + west + ', East: ' + east + '. Return ONLY valid JSON: {"polygons":[{"name":"name","type":"Garage|Markparkering|Pendelparkering","coordinates":[[lng,lat],...]}]}'
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5', max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Image } }, { type: 'text', text: prompt }] }]
    })
    const rawText = response.content[0].text.trim()
    const cleaned = rawText.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    const result = parsed.polygons.map(poly => ({ name: poly.name || 'Okand parkering', type: poly.type || 'Garage', latlngs: poly.coordinates.map(([lng, lat]) => [lat, lng]) }))
    res.json({ polygons: result, bbox: { south, west, north, east } })
  } catch (err) {
    console.error('Error:', err.message)
    res.status(500).json({ error: err.message })
  } finally {
    if (page) await page.close()
  }
})

app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0' }))
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log('Parkering backend v1.0.0 running on port ' + PORT))
