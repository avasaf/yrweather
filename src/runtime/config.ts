import { type ImmutableObject } from 'jimu-core'

export interface Config {
  sourceUrl: string
  autoRefreshEnabled: boolean
  refreshInterval: number
  svgCode: string

  overallBackground: string
  padding: number

  // Logos / text
  logoColor: string
  yrLogoBackgroundColor: string
  yrLogoTextColor: string
  yAxisIconColor: string          // used for BOTH Y and X axis icons
  mainTextColor: string
  secondaryTextColor: string

  // Grid
  gridLineColor: string
  gridLineWidth: number
  gridLineOpacity: number

  // Curves / bars
  temperatureLineColor: string
  windLineColor: string
  windGustLineColor: string
  precipitationBarColor: string
  maxPrecipitationColor: string

  // UI
  refreshIconColor: string
}

export type IMConfig = ImmutableObject<Config>
