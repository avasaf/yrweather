/** @jsx jsx */
import { React, AllWidgetProps, jsx, css, type SerializedStyles } from 'jimu-core'
import { Loading } from 'jimu-ui'
import ReactDOM from 'react-dom'
import { type IMConfig } from './config'

interface ForecastPoint {
  time: string
  temperature: number
  windSpeed: number
  windGust: number | null
  precipitation: number | null
}

interface ForecastPayload {
  updatedAt: string
  points: ForecastPoint[]
}

interface State {
  svgHtml: string
  isLoading: boolean
  error: string | null
  rawSvg: string | null
  expanded: boolean
}

export default class Widget extends React.PureComponent<AllWidgetProps<IMConfig>, State> {
  private refreshIntervalId: NodeJS.Timer = null

  constructor (props) {
    super(props)
    this.state = {
      svgHtml: null,
      isLoading: false,
      error: null,
      rawSvg: null,
      expanded: false
    }
  }

  componentDidMount(): void {
    this.handleDataSourceChange()
    this.setupAutoRefresh()
  }

  componentDidUpdate(prevProps: AllWidgetProps<IMConfig>): void {
    const cfg = this.props.config
    const prev = prevProps.config
    const fetchRelevantChanged =
      cfg.sourceUrl !== prev.sourceUrl ||
      cfg.autoRefreshEnabled !== prev.autoRefreshEnabled ||
      cfg.refreshInterval !== prev.refreshInterval

    if (fetchRelevantChanged) {
      this.handleDataSourceChange()
      this.setupAutoRefresh()
    } else if (cfg !== prev) {
      if (this.state.rawSvg) this.processSvg(this.state.rawSvg)
    }
  }

  componentWillUnmount(): void {
    if (this.refreshIntervalId) clearInterval(this.refreshIntervalId)
  }

  handleDataSourceChange = () => {
    const { config } = this.props
    if (config.sourceUrl) {
      this.fetchSvgFromUrl(config.sourceUrl)
    } else if (config.svgCode && !config.svgCode.trim().startsWith('<!--')) {
      this.processSvg(config.svgCode)
    } else {
      this.setState({ svgHtml: null, error: null, isLoading: false, rawSvg: null })
    }
  }

  setupAutoRefresh = (): void => {
    if (this.refreshIntervalId) clearInterval(this.refreshIntervalId)
    if (this.props.config.autoRefreshEnabled && this.props.config.refreshInterval > 0 && this.props.config.sourceUrl) {
      const ms = this.props.config.refreshInterval * 60 * 1000
      this.refreshIntervalId = setInterval(() => this.fetchSvgFromUrl(this.props.config.sourceUrl), ms)
    }
  }

  toggleExpand = (): void => {
    this.setState({ expanded: !this.state.expanded })
  }

  fetchSvgFromUrl = (url: string, attempt = 1): void => {
    if (attempt === 1) {
      this.setState({ isLoading: true, error: null })
    }

    const coords = this.extractCoordinates(url)
    if (coords) {
      this.fetchFromForecastApi(url, coords, attempt)
      return
    }

    this.fetchSvgDirect(url, attempt)
  }

  fetchSvgDirect = (url: string, attempt = 1): void => {
    let requestUrl = url
    try {
      const urlObj = new URL(url)
      urlObj.searchParams.set('nocache', Date.now().toString())
      requestUrl = urlObj.toString()
    } catch (err) {
      requestUrl = url + (url.includes('?') ? '&' : '?') + 'nocache=' + Date.now()
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    if (controller) {
      timeoutId = setTimeout(() => controller.abort(), 15000)
    }

    const fetchOptions: RequestInit = {
      cache: 'no-store',
      mode: 'cors',
      credentials: 'omit',
      headers: { Accept: 'image/svg+xml,text/html;q=0.9,*/*;q=0.8' }
    }
    if (controller) fetchOptions.signal = controller.signal

    fetch(requestUrl, fetchOptions)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text() })
      .then(text => {
        const t = text.trim()
        let svgString: string

        if (t.startsWith('<svg') || t.startsWith('<?xml')) {
          svgString = t
        } else {
          const doc = new DOMParser().parseFromString(t, 'text/html')
          const svgEl = doc.querySelector('svg')
          if (!svgEl) throw new Error('No SVG element found in fetched content.')
          svgString = svgEl.outerHTML
        }

        this.processSvg(svgString)

        if (svgString.startsWith('<svg')) {
          this.props.onSettingChange({
            id: this.props.id,
            config: this.props.config.set('svgCode', svgString)
          })
        }
      })
      .catch(err => {
        if (controller) controller.abort()
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        if (attempt < 5) {
          setTimeout(() => this.fetchSvgDirect(url, attempt + 1), 1000 * attempt)
          return
        }
        console.error('Failed to fetch SVG:', err)

        const fallback = this.state.rawSvg || this.props.config.svgCode
        if (fallback && fallback.trim().startsWith('<svg')) {
          this.processSvg(fallback)
          return
        }

        this.setState({
          isLoading: false,
          error: 'Unable to load meteogram from source.'
        })
      })
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId)
      })
  }

  extractCoordinates = (url: string): { lat: number, lon: number } | null => {
    try {
      const parsed = new URL(url)
      const pathSegments = parsed.pathname.split('/').filter(Boolean)
      const coordSegment = pathSegments.find(seg => /-?\d+\.\d+,-?\d+\.\d+/.test(seg))
      if (!coordSegment) return null
      const [latRaw, lonRaw] = coordSegment.split(',')
      const lat = parseFloat(latRaw)
      const lon = parseFloat(lonRaw)
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return { lat, lon }
      }
      return null
    } catch (err) {
      return null
    }
  }

  fetchFromForecastApi = (originalUrl: string, coords: { lat: number, lon: number }, attempt: number): void => {
    const query = new URLSearchParams({
      lat: coords.lat.toString(),
      lon: coords.lon.toString()
    })
    const endpoint = `https://api.met.no/weatherapi/locationforecast/2.0/compact?${query.toString()}`

    fetch(endpoint, {
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        Accept: 'application/json'
      }
    })
      .then(res => {
        if (!res.ok) throw new Error(`Forecast HTTP ${res.status}`)
        return res.json()
      })
      .then(data => {
        const payload = this.transformForecast(data)
        if (!payload || payload.points.length === 0) throw new Error('No forecast points available.')
        const svg = this.generateForecastSvg(payload)
        this.processSvg(svg)
        this.props.onSettingChange({
          id: this.props.id,
          config: this.props.config.set('svgCode', svg)
        })
      })
      .catch(err => {
        console.error('Failed to build meteogram from forecast API:', err)
        if (attempt < 5) {
          setTimeout(() => this.fetchFromForecastApi(originalUrl, coords, attempt + 1), 1000 * attempt)
          return
        }
        const fallback = this.state.rawSvg || this.props.config.svgCode
        if (fallback && fallback.trim().startsWith('<svg')) {
          this.processSvg(fallback)
          return
        }
        this.setState({
          isLoading: false,
          error: 'Unable to load forecast data.'
        })
      })
  }

  transformForecast = (data: any): ForecastPayload | null => {
    const updatedAt: string | undefined = data?.properties?.meta?.updated_at
    const series: any[] = Array.isArray(data?.properties?.timeseries) ? data.properties.timeseries : []
    if (!series.length) return null

    const points: ForecastPoint[] = []
    for (const entry of series.slice(0, 48)) {
      const time = entry?.time
      const instant = entry?.data?.instant?.details ?? {}
      if (!time || typeof instant.air_temperature !== 'number' || typeof instant.wind_speed !== 'number') continue

      const next1 = entry?.data?.next_1_hours?.details ?? null
      const next6 = entry?.data?.next_6_hours?.details ?? null

      points.push({
        time,
        temperature: instant.air_temperature,
        windSpeed: instant.wind_speed,
        windGust: typeof instant.wind_speed_of_gust === 'number'
          ? instant.wind_speed_of_gust
          : typeof next1?.wind_speed_of_gust === 'number'
            ? next1.wind_speed_of_gust
            : typeof next6?.wind_speed_of_gust === 'number'
              ? next6.wind_speed_of_gust
              : null,
        precipitation: typeof next1?.precipitation_amount === 'number'
          ? next1.precipitation_amount
          : typeof next6?.precipitation_amount === 'number'
            ? next6.precipitation_amount / 6
            : null
      })
    }

    if (!points.length) return null

    return {
      updatedAt: updatedAt || new Date().toISOString(),
      points
    }
  }

  generateForecastSvg = (forecast: ForecastPayload): string => {
    const { config } = this.props
    const width = 960
    const height = 540
    const margin = { top: 64, right: 36, bottom: 80, left: 72 }
    const innerWidth = width - margin.left - margin.right
    const innerHeight = height - margin.top - margin.bottom
    const tempSection = innerHeight * 0.55
    const precipSection = innerHeight * 0.25
    const windSection = innerHeight * 0.2

    const pts = forecast.points
    const temperatures = pts.map(p => p.temperature)
    const windSpeeds = pts.map(p => p.windSpeed)
    const gusts = pts.map(p => p.windGust ?? p.windSpeed)
    const precipValues = pts.map(p => p.precipitation ?? 0)

    const tempMax = Math.max(...temperatures, 5)
    const tempMin = Math.min(...temperatures, -5)
    const tempRange = Math.max(tempMax - tempMin, 5)

    const windMax = Math.max(...gusts, ...windSpeeds, 5)
    const precipMax = Math.max(...precipValues, 1)

    const xStep = pts.length > 1 ? innerWidth / (pts.length - 1) : 0

    const xPos = (index: number) => margin.left + xStep * index
    const tempY = (value: number) => margin.top + (tempMax - value) / tempRange * tempSection
    const precipHeight = (value: number) => (value / precipMax) * precipSection
    const precipBase = margin.top + tempSection + precipSection
    const windYBase = precipBase + windSection
    const windY = (value: number) => windYBase - (value / windMax) * windSection

    const tempPath = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xPos(i).toFixed(2)},${tempY(p.temperature).toFixed(2)}`)
      .join(' ')

    const windPath = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xPos(i).toFixed(2)},${windY(p.windSpeed).toFixed(2)}`)
      .join(' ')

    const gustPath = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xPos(i).toFixed(2)},${windY((p.windGust ?? p.windSpeed)).toFixed(2)}`)
      .join(' ')

    const hoursFormatter = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      hour12: false
    })
    const dayFormatter = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    })

    const updatedText = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(forecast.updatedAt))

    const xLabels: { x: number, hour: string, day?: string }[] = []
    pts.forEach((p, i) => {
      const date = new Date(p.time)
      const hourLabel = hoursFormatter.format(date)
      if (i % 3 === 0) {
        const entry: { x: number, hour: string, day?: string } = { x: xPos(i), hour: hourLabel }
        if (date.getUTCHours() === 0) {
          entry.day = dayFormatter.format(date)
        }
        xLabels.push(entry)
      }
    })

    const tempTicks = []
    const step = tempRange <= 10 ? 1 : tempRange <= 20 ? 2 : 5
    for (let val = Math.ceil(tempMin / step) * step; val <= tempMax; val += step) {
      tempTicks.push(val)
    }

    const gridLines = tempTicks.map(val => {
      const y = tempY(val).toFixed(2)
      return `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="${config.gridLineColor}" stroke-width="${config.gridLineWidth}" stroke-opacity="${config.gridLineOpacity}" />`
    }).join('')

    const tempTickLabels = tempTicks.map(val => {
      const y = tempY(val).toFixed(2)
      return `<text x="${margin.left - 10}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="12" fill="${config.secondaryTextColor}">${val.toFixed(0)}°</text>`
    }).join('')

    const precipBars = pts.map((p, i) => {
      const value = p.precipitation ?? 0
      if (value <= 0) return ''
      const barHeight = Math.max(2, precipHeight(value))
      const x = xPos(i) - Math.max(2, xStep * 0.35)
      const barWidth = Math.max(4, xStep * 0.7)
      const y = precipBase - barHeight
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" fill="${config.precipitationBarColor}" />`
    }).join('')

    const xLabelElements = xLabels.map(label => {
      const y = height - margin.bottom + 20
      const dayText = label.day ? `<text x="${label.x.toFixed(2)}" y="${y + 18}" text-anchor="middle" font-size="12" fill="${config.secondaryTextColor}">${label.day}</text>` : ''
      return `
        <g>
          <text x="${label.x.toFixed(2)}" y="${y}" text-anchor="middle" font-size="12" fill="${config.mainTextColor}">${label.hour}</text>
          ${dayText}
        </g>
      `
    }).join('')

    const windTicks = []
    const windStep = windMax <= 10 ? 2 : windMax <= 20 ? 5 : 10
    for (let val = 0; val <= windMax; val += windStep) {
      const y = windY(val).toFixed(2)
      windTicks.push(`<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="${config.gridLineColor}" stroke-width="0.5" stroke-opacity="${config.gridLineOpacity * 0.5}" />`)
      windTicks.push(`<text x="${width - margin.right + 8}" y="${y}" font-size="11" fill="${config.secondaryTextColor}" dominant-baseline="middle">${val.toFixed(0)} m/s</text>`)
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="meteogramTitle meteogramDesc">
  <title id="meteogramTitle">YR meteogram</title>
  <desc id="meteogramDesc">Temperature, precipitation and wind forecast derived from api.met.no</desc>
  <rect x="0" y="0" width="${width}" height="${height}" fill="${config.overallBackground}" />
  <g font-family="sans-serif">
    <text x="${margin.left}" y="32" font-size="20" fill="${config.mainTextColor}">Weather forecast</text>
    <text x="${margin.left}" y="52" font-size="12" fill="${config.secondaryTextColor}">Updated ${updatedText}</text>
  </g>
  <g>
    ${gridLines}
    ${tempTickLabels}
    <path d="${tempPath}" fill="none" stroke="${config.temperatureLineColor}" stroke-width="2.5" />
  </g>
  <g>
    ${precipBars}
  </g>
  <g>
    <path d="${windPath}" fill="none" stroke="${config.windLineColor}" stroke-width="2" />
    <path d="${gustPath}" fill="none" stroke="${config.windGustLineColor}" stroke-width="2" stroke-dasharray="6 4" />
    ${windTicks.join('')}
  </g>
  <g>
    ${xLabelElements}
    <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="${config.gridLineColor}" stroke-width="1" stroke-opacity="${config.gridLineOpacity}" />
  </g>
  <g font-size="12">
    <text x="${margin.left}" y="${margin.top - 20}" fill="${config.mainTextColor}">Temperature (°C)</text>
    <text x="${margin.left}" y="${precipBase - precipSection - 8}" fill="${config.mainTextColor}">Precipitation (mm)</text>
    <text x="${margin.left}" y="${windYBase - windSection - 8}" fill="${config.mainTextColor}">Wind speed (m/s)</text>
  </g>
</svg>`
  }

  processSvg = (svgCode: string): void => {
    const { config } = this.props
    const doc = new DOMParser().parseFromString(svgCode, 'image/svg+xml')
    const svg = doc.querySelector('svg')
    if (!svg) { this.setState({ error: 'Invalid SVG content', isLoading: false }); return }

    if (!svg.hasAttribute('viewBox')) {
      const w = svg.getAttribute('width')?.replace('px', '')
      const h = svg.getAttribute('height')?.replace('px', '')
      if (w && h) svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    }

    // Remove fixed dimensions so SVG can scale to its container
    svg.removeAttribute('width')
    svg.removeAttribute('height')
    if (!svg.getAttribute('preserveAspectRatio')) {
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    }

    svg.querySelectorAll('style').forEach(s => s.remove())
    svg.querySelectorAll('filter').forEach(f => f.remove())
    svg.querySelectorAll('[filter]').forEach(n => n.removeAttribute('filter'))

    const isWhite = (v?: string | null) => {
      const t = (v || '').trim().toLowerCase()
      return t === '#fff' || t === '#ffffff' || t === 'white' || t === 'rgb(255,255,255)'
    }
    svg.querySelectorAll('rect').forEach(r => {
      const fill = r.getAttribute('fill')
      const style = r.getAttribute('style') || ''
      if (isWhite(fill) || /(^|;)\s*fill\s*:\s*(#fff|#ffffff|white|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))\s*;?/i.test(style)) {
        r.setAttribute('fill', 'none')
        r.setAttribute('style', style.replace(/(^|;)\s*fill\s*:\s*[^;]+;?/ig, '$1'))
      }
    })
    svg.querySelectorAll('foreignObject').forEach(fo => {
      const html = fo.querySelector('*') as HTMLElement | null
      if (html) html.setAttribute('style', `${html.getAttribute('style') || ''};background:${config.overallBackground} !important;`)
    })
    this.setState({
      svgHtml: svg.outerHTML,
      isLoading: false,
      error: null,
      rawSvg: svgCode
    })
  }

  buildScopedCss = (config: IMConfig, scope: string) => `
    .${scope} { background-color: ${config.overallBackground}; position: relative; }

    .${scope} .button-container { position: absolute; top: clamp(24px,3vw,32px); left: 50%; transform: translate(-50%, -50%); display: flex; gap: clamp(6px,1vw,12px); z-index: 10; }
    .${scope} .action-button {
      cursor: pointer; border: none; line-height: 0;
      display: flex; align-items: center; justify-content: center;
      height: clamp(24px,3vw,28px); width: clamp(24px,3vw,28px); border-radius: ${config.expandButtonBorderRadius}px;
    }
    .${scope} .refresh-button { background: ${config.refreshButtonBackgroundColor}; color: ${config.refreshButtonIconColor}; }
    .${scope} .refresh-button svg path { stroke: currentColor !important; fill: none !important; }
    .${scope} .refresh-button.large { width: clamp(36px,4vw,44px); height: clamp(36px,4vw,44px); }
    .${scope} .expand-button { background: ${config.expandButtonBackgroundColor}; color: ${config.expandButtonIconColor}; font-size: 16px; }

    .${scope} .svg-image-container svg {
      width: 100%;
      height: auto;
      max-height: 100%;
      display: block;
      background-color: ${config.overallBackground} !important;
    }

    /* Text */
    .${scope} .svg-image-container svg .location-header,
    .${scope} .svg-image-container svg .day-label,
    .${scope} .svg-image-container svg .served-by-header,
    .${scope} .svg-image-container svg .legend-label,
    .${scope} .svg-image-container svg text { fill: ${config.mainTextColor} !important; }
    .${scope} .svg-image-container svg .hour-label,
    .${scope} .svg-image-container svg .y-axis-label { fill: ${config.secondaryTextColor} !important; }

    /* Axis/X icons colored */
    .${scope} .svg-image-container svg g[filter*="invert"] { filter:none !important; }
    .${scope} .svg-image-container svg [fill="#56616c"],
    .${scope} .svg-image-container svg [stroke="#56616c"],
    .${scope} .svg-image-container svg [style*="fill:#56616c"],
    .${scope} .svg-image-container svg [style*="stroke:#56616c"],
    .${scope} .svg-image-container svg [style*="rgb(86,97,108)"] {
      fill: ${config.yAxisIconColor} !important;
      stroke: ${config.yAxisIconColor} !important;
    }
    .${scope} .svg-image-container svg [stroke="currentColor"] { stroke: ${config.yAxisIconColor} !important; }
    .${scope} .svg-image-container svg [fill="currentColor"]   { fill: ${config.yAxisIconColor} !important; }

    /* Grid */
    .${scope} .svg-image-container svg line[stroke="#c3d0d8"],
    .${scope} .svg-image-container svg line[stroke="#56616c"] {
      stroke: ${config.gridLineColor} !important;
      stroke-width: ${config.gridLineWidth}px !important;
      stroke-opacity: ${config.gridLineOpacity} !important;
    }

    /* Series lines */
    .${scope} .svg-image-container svg path[stroke="url(#temperature-curve-gradient)"] { stroke: ${config.temperatureLineColor} !important; }
    .${scope} .svg-image-container svg path[stroke="#aa00f2"]:not([stroke-dasharray]) { stroke: ${config.windLineColor} !important; }
    .${scope} .svg-image-container svg path[stroke="#aa00f2"][stroke-dasharray] { stroke: ${config.windGustLineColor} !important; }

    /* Legend chips (inline <svg> blocks) */
    /* Temperature chip is red by default */
    .${scope} .svg-image-container svg svg rect[fill="#c60000"] { fill: ${config.temperatureLineColor} !important; }

    /* Wind m/s chip: solid purple rect WITHOUT rx */
    .${scope} .svg-image-container svg svg rect[fill="#aa00f2"]:not([rx]) { fill: ${config.windLineColor} !important; }

    /* Wind gust chip: purple rect WITH rx (rounded) */
    .${scope} .svg-image-container svg svg rect[fill="#aa00f2"][rx] { fill: ${config.windGustLineColor} !important; }

    /* Precipitation */
    .${scope} .svg-image-container svg rect[fill="#006edb"] { fill: ${config.precipitationBarColor} !important; }
    .${scope} .svg-image-container svg line[stroke="#006edb"],
    .${scope} .svg-image-container svg path[stroke="#006edb"] { stroke: ${config.precipitationBarColor} !important; }

    .${scope} .svg-image-container svg #max-precipitation-pattern rect { fill: ${config.maxPrecipitationColor} !important; opacity: 0.3 !important; }
    .${scope} .svg-image-container svg #max-precipitation-pattern line { stroke: ${config.maxPrecipitationColor} !important; opacity: 1 !important; }

    /* Logos */
    .${scope} .svg-image-container svg svg[x="16"] circle { fill: ${config.yrLogoBackgroundColor} !important; }
    .${scope} .svg-image-container svg svg[x="16"] path   { fill: ${config.yrLogoTextColor} !important; }
    .${scope} .svg-image-container svg svg[x="624"] path,
    .${scope} .svg-image-container svg svg[x="675.5"] path { fill: ${config.logoColor} !important; }
  `

  getStyle = (config: IMConfig): SerializedStyles => css`
    & {
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      padding: ${config.padding ?? 0}px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .svg-image-container {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      border-radius: inherit;
    }
  `

  render(): React.ReactElement {
    const { config, id } = this.props
    const { isLoading, error, svgHtml, expanded } = this.state
    const scopeClass = `yrw-${id}`

    const content = isLoading
      ? <Loading />
      : error
        ? <div style={{ padding: '10px', textAlign: 'center', color: 'red' }}>
            {error}
            {config.sourceUrl && (
              <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}>
                <button
                  className="action-button refresh-button large"
                  onClick={() => this.fetchSvgFromUrl(config.sourceUrl)}
                  title="Refresh graph"
                  aria-label="Refresh graph"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" role="img" aria-hidden="true">
                    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                      d="M21 12a9 9 0 1 1-3.4-7L21 8m0-4v4h-4" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        : svgHtml
          ? <div
            className="svg-image-container"
            style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderRadius: 'inherit' }}
            dangerouslySetInnerHTML={{ __html: svgHtml }}
          />
          : <div style={{ padding: 10, textAlign: 'center' }}>
              Please configure a Source URL or provide Fallback SVG Code.
            </div>

    const showControls = this.props.config.sourceUrl && !expanded && !error

    return (
      <div className={scopeClass} css={this.getStyle(config)}>
        <style dangerouslySetInnerHTML={{ __html: this.buildScopedCss(config, scopeClass) }} />

        {showControls && (
          <div className="button-container">
            <button
              className="action-button refresh-button"
              onClick={() => this.fetchSvgFromUrl(config.sourceUrl)}
              title="Refresh graph"
              aria-label="Refresh graph"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" role="img" aria-hidden="true">
                <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  d="M21 12a9 9 0 1 1-3.4-7L21 8m0-4v4h-4" />
              </svg>
            </button>
            <button
              className="action-button expand-button"
              onClick={this.toggleExpand}
              title="Expand graph"
              aria-label="Expand graph"
            >⛶</button>
          </div>
        )}

        {!expanded && content}

        {expanded && ReactDOM.createPortal(
          <div className={`${scopeClass} popup`}>
            {config.blockPage && (
              <div
                onClick={this.toggleExpand}
                style={{
                  position: 'fixed',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background: config.maskColor,
                  zIndex: 2147483646
                }}
              />
            )}
            <div
              style={{
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: '70vw',
                height: '70vh',
                background: config.popupBackgroundColor,
                zIndex: 2147483647,
                padding: `${config.popupPadding}px`,
                borderRadius: `${config.popupBorderRadius}px`,
                boxShadow: `${config.popupBoxShadowOffsetX}px ${config.popupBoxShadowOffsetY}px ${config.popupBoxShadowBlur}px ${config.popupBoxShadowSpread}px ${config.popupBoxShadowColor}`,
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <div className="button-container">
                <button
                  className="action-button refresh-button"
                  onClick={() => this.fetchSvgFromUrl(config.sourceUrl)}
                  title="Refresh graph"
                  aria-label="Refresh graph"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" role="img" aria-hidden="true">
                    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                      d="M21 12a9 9 0 1 1-3.4-7L21 8m0-4v4h-4" />
                  </svg>
                </button>
                <button
                  className="action-button expand-button"
                  onClick={this.toggleExpand}
                  title="Close graph"
                  aria-label="Close graph"
                >×</button>
              </div>
              {content}
            </div>
          </div>,
          document.body
        )}
      </div>
    )
  }
}
