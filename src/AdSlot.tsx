import { useEffect } from 'react'

type AdPlacement = 'header' | 'chart-footer' | 'genre-sidebar'

type AdSlotProps = {
  placement: AdPlacement
  className?: string
}

declare global {
  interface Window {
    adsbygoogle?: unknown[]
  }
}

const adsEnabled = import.meta.env.VITE_ENABLE_ADS === 'true'
const adClient = import.meta.env.VITE_ADSENSE_CLIENT || ''

const slotByPlacement: Record<AdPlacement, string> = {
  header: import.meta.env.VITE_AD_SLOT_HEADER || '',
  'chart-footer': import.meta.env.VITE_AD_SLOT_CHART_FOOTER || '',
  'genre-sidebar': import.meta.env.VITE_AD_SLOT_GENRE_SIDEBAR || '',
}

function loadAdsenseScript(client: string) {
  if (document.querySelector(`script[data-chart-atlas-adsense="${client}"]`)) return

  const script = document.createElement('script')
  script.async = true
  script.crossOrigin = 'anonymous'
  script.dataset.chartAtlasAdsense = client
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`
  document.head.appendChild(script)
}

function AdSlot({ placement, className = '' }: AdSlotProps) {
  const slot = slotByPlacement[placement]
  const shouldRender = adsEnabled && Boolean(adClient) && Boolean(slot)

  useEffect(() => {
    if (!shouldRender) return

    loadAdsenseScript(adClient)
    window.adsbygoogle = window.adsbygoogle || []

    try {
      window.adsbygoogle.push({})
    } catch {
      // AdSense may reject duplicate fills during hot reloads or rapid tab changes.
    }
  }, [placement, shouldRender, slot])

  if (!shouldRender) return null

  return (
    <aside className={`ad-slot ad-slot-${placement} ${className}`} aria-label="advertisement">
      <span>Advertisement</span>
      <ins
        className="adsbygoogle"
        data-ad-client={adClient}
        data-ad-slot={slot}
        data-ad-format={placement === 'header' ? undefined : 'auto'}
        data-full-width-responsive={placement === 'header' ? 'false' : 'true'}
      />
    </aside>
  )
}

export default AdSlot
