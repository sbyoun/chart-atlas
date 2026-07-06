export type Locale = 'en' | 'ko'

export function pick(locale: Locale, en: string, ko: string) {
  return locale === 'ko' ? ko : en
}

export function formatCount(
  locale: Locale,
  count: number,
  enSingular: string,
  enPlural: string,
  koUnit: string,
) {
  if (locale === 'ko') {
    return `${count}${koUnit}`
  }

  return `${count} ${count === 1 ? enSingular : enPlural}`
}

export function formatNumberForLocale(locale: Locale, value: number) {
  return new Intl.NumberFormat(locale === 'ko' ? 'ko-KR' : 'en-US', {
    maximumFractionDigits: 0,
  }).format(value)
}
