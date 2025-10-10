/** @jsx jsx */
import { React, AllWidgetProps, jsx, css, type SerializedStyles } from 'jimu-core'
import { Loading } from 'jimu-ui'
import ReactDOM from 'react-dom'
import { type IMConfig } from './config'

type DisplayMode = 'inline' | 'external'

interface State {
  svgHtml: string
  isLoading: boolean
  error: string | null
  rawSvg: string | null
  expanded: boolean
  displayMode: DisplayMode
  externalUrl: string | null
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
      expanded: false,
      displayMode: 'inline',
      externalUrl: null
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
      this.setState({ svgHtml: null, error: null, isLoading: false, rawSvg: null, displayMode: 'inline', externalUrl: null })
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
      this.setState({ isLoading: true, error: null, displayMode: 'inline', externalUrl: null })
    }

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
          setTimeout(() => this.fetchSvgFromUrl(url, attempt + 1), 1000 * attempt)
          return
        }
        console.error('Failed to fetch SVG:', err)

        const fallback = this.state.rawSvg || this.props.config.svgCode
        if (fallback && fallback.trim().startsWith('<svg')) {
          this.processSvg(fallback)
          return
        }

        const externalUrl = requestUrl
        this.setState({
          isLoading: false,
          error: null,
          displayMode: 'external',
          externalUrl
        })
      })
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId)
      })
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId)
      })
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
      rawSvg: svgCode,
      displayMode: 'inline',
      externalUrl: null
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
    const { isLoading, error, svgHtml, expanded, displayMode, externalUrl } = this.state
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
        : (displayMode === 'external' && externalUrl
            ? <div className="svg-image-container" style={{ width: '100%', height: '100%' }}>
              <iframe
                src={externalUrl}
                title="YR meteogram"
                loading="lazy"
                style={{
                  width: '100%',
                  height: '100%',
                  border: 'none',
                  background: config.overallBackground
                }}
              />
            </div>
            : svgHtml
              ? <div
                className="svg-image-container"
                style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderRadius: 'inherit' }}
                dangerouslySetInnerHTML={{ __html: svgHtml }}
              />
            : <div style={{ padding: 10, textAlign: 'center' }}>
                Please configure a Source URL or provide Fallback SVG Code.
              </div>)

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
