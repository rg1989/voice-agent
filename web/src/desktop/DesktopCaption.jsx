import { t } from '../i18n.js'

const STATUS_LABELS = Object.freeze({
  listening: '正在听你说',
  working: '正在处理',
  replying: '正在回复',
})

// Passive caption under (or above) the orb. It never takes pointer events, so
// it cannot start an orb drag or block a click on the video below it.
export default function DesktopCaption({ status, text = '', fading = false }) {
  return <div
    className={`desktop-caption ${status}${fading ? ' fading' : ''}`}
    role="status"
    aria-live="polite"
  >
    <span className="desktop-caption-state">
      <i aria-hidden="true" />
      {t(STATUS_LABELS[status])}
    </span>
    {text && <p>{text}</p>}
  </div>
}
