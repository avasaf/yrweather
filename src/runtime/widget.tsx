/** @jsx jsx */
import { React, AllWidgetProps, jsx, css, type SerializedStyles } from 'jimu-core'
import { Loading } from 'jimu-ui'
import { type IMConfig } from './config'

interface State {
  svgHtml: string
  isLoading: boolean
  error: string | null
  rawSvg: string | null
}

export default class Widget extends React.PureComponent<AllWidgetProps<IMConfig>, State> {
  private refreshIntervalId: NodeJS.Timer = null

  constructor (props) {
    super(props)
    this.state = { svgHtml: null, isLoading: false, error: null, rawSvg: null }
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

  fetchSvgFromUrl = (url: string): void => {
    this.setState({ isLoading: true, error: null })
    const proxyUrl = 'https://api.allorigins.win/raw?url='
    const finalUrl = `${proxyUrl}${encodeURIComponent(url)}`

    fetch(finalUrl)
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
        console.error('Failed to fetch SVG:', err)
        this.setState({ error: 'Failed to load graph. Using fallback if available.', isLoading: false })

        const fallback = this.state.rawSvg || this.props.config.svgCode
        if (fallback && fallback.trim().startsWith('<svg')) {
          this.processSvg(fallback)
        }
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

    this.setState({ svgHtml: svg.outerHTML, isLoading: false, error: null, rawSvg: svgCode })
  }

  buildScopedCss = (config: IMConfig, scope: string) => `
    .${scope} { background-color: ${config.overallBackground}; position: relative; }

    .${scope} .refresh-button {
      position: absolute; top: 15px; right: 15px;
      cursor: pointer; background: rgba(255,255,255,0.5);
      border-radius: 50%; padding: 2px; z-index: 10; line-height: 0; border: none;
      color: ${config.refreshIconColor};
    }
    .${scope} .refresh-button svg path { stroke: currentColor !important; fill: none !important; }

    .${scope} .svg-image-container svg { width:100%; height:100%; display:block; background-color:${config.overallBackground} !important; }

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
    }
  `

  render(): React.ReactElement {
    const { config, id } = this.props
    const { isLoading, error, svgHtml } = this.state
    const scopeClass = `yrw-${id}`

    if (isLoading) return <Loading />
    if (error) return <div style={{ padding: '10px', textAlign: 'center', color: 'red' }}>{error}</div>

    return (
      <div className={scopeClass} css={this.getStyle(config)}>
        <style dangerouslySetInnerHTML={{ __html: this.buildScopedCss(config, scopeClass) }} />

        {this.props.config.sourceUrl && (
          <button
            className="refresh-button"
            onClick={() => this.fetchSvgFromUrl(config.sourceUrl)}
            title="Refresh graph"
            aria-label="Refresh graph"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" role="img" aria-hidden="true">
              <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                d="M21 12a9 9 0 1 1-3.4-7L21 8m0-4v4h-4" />
            </svg>
          </button>
        )}

        {svgHtml
          ? <div className="svg-image-container" dangerouslySetInnerHTML={{ __html: svgHtml }} />
          : <div style={{ padding: 10, textAlign: 'center' }}>
              Please configure a Source URL or provide Fallback SVG Code.
            </div>}
      </div>
    )
  }
}
