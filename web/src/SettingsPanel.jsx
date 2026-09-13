import { useCallback, useEffect, useState } from 'react'
import { t } from './i18n.js'
import FolderPicker from './FolderPicker.jsx'
import { RECOMMENDED_WAKE_WORD } from './listening.js'
import {
  fetchSettings,
  saveSettings,
  waitForGatewayThenReload,
} from './settings-api.js'

// 设置面板：选后台 Agent、工作目录和音色。
//
// 这三项都在 Gateway 启动时读入，所以改完要重启。重启由服务端的分离子进程完成，
// 这里只负责等 /api/health 重新应答，然后刷新页面重新握手。
//
// 目录用服务端列目录 + 点击进入的方式选：浏览器的 <input type="file"> 拿不到
// 真实路径，那是安全限制。Gateway 本来就跑在本机，列目录比让人手抄路径好得多。


// 拖动过程中只改显示，松手（或键盘松键）才真正保存：每次保存都会重启 Gateway，
// 按住不放一路重启是不能接受的。
function TurnSlider({ label, hint, value, min, max, step, disabled, format, onCommit }) {
  const [dragging, setDragging] = useState(null)
  const shown = dragging === null ? value : dragging
  const commit = () => {
    if (dragging === null) return
    const next = dragging
    setDragging(null)
    if (next !== value) onCommit(next)
  }
  return <label className="settings-slider">
    <span className="settings-slider-head">
      <b>{label}</b>
      <small>{format(shown)}</small>
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={shown}
      disabled={disabled}
      onChange={event => setDragging(Number(event.target.value))}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
    />
    <small className="settings-hint">{hint}</small>
  </label>
}

function listeningModeText(option) {
  if (option.id === 'always') return [t('一直在听'), t('麦克风听到的声音都会发给语音模型。')]
  if (option.id === 'wake_word') return [t('唤醒词'), t('听到唤醒词之后才发给语音模型。')]
  return [option.label, option.detail]
}

// Listening mode, wake word and follow-up window. The gateway applies these
// live and answers restarting:false, so save() only refreshes.
export function ListeningSettings({ settings, disabled, save }) {
  if (!Array.isArray(settings?.listeningModes)) return null
  const followUp = settings.followUpDefaults || {}
  const followUpMin = Math.max(0, followUp.min ?? 0)
  const followUpMax = Math.min(15, followUp.max ?? 15)
  const followUpSeconds = Math.min(
    followUpMax,
    Math.max(followUpMin, settings.followUpSeconds ?? followUp.seconds ?? 5),
  )
  return <section className="settings-group">
    <h4>{t('聆听方式')}</h4>
    <p className="settings-hint">{t('麦克风听到的声音什么时候交给语音模型。改完立即生效，不会重启 Gateway。')}</p>
    <div className="settings-options">
      {settings.listeningModes.map(option => {
        const [label, detail] = listeningModeText(option)
        return <button
          key={option.id}
          type="button"
          className={`settings-option${settings.listeningMode === option.id ? ' selected' : ''}`}
          disabled={disabled}
          onClick={() => save({ listeningMode: option.id })}
        >
          <b>{label}</b>
          <small>{detail}</small>
        </button>
      })}
    </div>
    {settings.listeningMode === 'wake_word' && <>
      <p className="settings-hint">{t('选一个唤醒词。')}</p>
      <div className="settings-options">
        {(settings.wakeWords || []).map(option => <button
          key={option.id}
          type="button"
          className={`settings-option${settings.wakeWord === option.id ? ' selected' : ''}`}
          disabled={disabled}
          onClick={() => save({ wakeWord: option.id })}
        >
          <b>{option.label}</b>
          {option.id === RECOMMENDED_WAKE_WORD && <small>{t('推荐')}</small>}
        </button>)}
      </div>
      <TurnSlider
        label={t('回答后继续听多久')}
        hint={t('助手回答完后继续听这么久，过了就要重新说唤醒词。')}
        value={followUpSeconds}
        min={followUpMin}
        max={followUpMax}
        step={1}
        disabled={disabled}
        format={value => t('{count} 秒', { count: value })}
        onCommit={value => save({ followUpSeconds: value })}
      />
    </>}
  </section>
}

export default function SettingsPanel({ onClose, setOutputVoice }) {
  const [settings, setSettings] = useState(null)
  const [browsing, setBrowsing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [error, setError] = useState('')
  const [sampling, setSampling] = useState('')

  const refresh = useCallback(async () => {
    try {
      setSettings(await fetchSettings())
    } catch {
      setError(t('读不到设置'))
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const save = useCallback(async patch => {
    if (busy || restarting) return
    setBusy(true)
    setError('')
    try {
      const payload = await saveSettings(patch)
      if (patch.voice && !payload.restarting && setOutputVoice) {
        await setOutputVoice(patch.voice).catch(() => {})
      }
      if (payload.restarting) {
        setRestarting(true)
        const ok = await waitForGatewayThenReload()
        if (!ok) {
          setRestarting(false)
          setError(t('重启超时，请手动刷新页面'))
        }
      } else {
        await refresh()
      }
    } catch (caught) {
      setError(caught.message || t('保存失败'))
    } finally {
      setBusy(false)
    }
  }, [busy, restarting, refresh, setOutputVoice])

  const disabled = busy || restarting || !settings

  return <aside className="settings-panel" aria-label={t('设置')}>
    <header>
      <b>{t('设置')}</b>
      {onClose && <button type="button" className="header-action" onClick={onClose} aria-label={t('关闭')} title={t('关闭')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg></button>}
    </header>

    {restarting && <p className="settings-notice" role="status">
      {t('正在重启 Gateway，稍后自动刷新…')}
    </p>}
    {error && <p className="settings-error" role="alert">{error}</p>}

    {!settings
      ? <p className="settings-hint">{t('正在读取设置…')}</p>
      : <>
        <section className="settings-group">
          <h4>{t('大脑')}</h4>
          <p className="settings-hint">{t('谁来做真正的活儿。各自沿用自己的模型和登录。')}</p>
          <div className="settings-options">
            {settings.brains.map(option => <button
              key={option.id}
              type="button"
              className={`settings-option${settings.brain === option.id ? ' selected' : ''}`}
              disabled={disabled}
              onClick={() => save({ brain: option.id })}
            >
              <b>{option.label}</b>
              <small>{option.detail}</small>
            </button>)}
          </div>
        </section>

        <ListeningSettings settings={settings} disabled={disabled} save={save} />

        {settings.computerUseOptions && <section className="settings-group">
          <h4>{t('电脑控制')}</h4>
          <p className="settings-hint">{t('后台 Agent 能不能看你的屏幕、用你的鼠标和键盘，以及什么时候要先问你。改完会重启 Gateway。')}</p>
          <div className="settings-options">
            {settings.computerUseOptions.map(option => <button
              key={option.id}
              type="button"
              className={`settings-option${settings.computerUse === option.id ? ' selected' : ''}`}
              disabled={disabled}
              onClick={() => save({ computerUse: option.id })}
            >
              <b>{option.label}</b>
              <small>{option.detail}</small>
            </button>)}
          </div>
        </section>}

        <section className="settings-group">
          <h4>{t('工作目录')}</h4>
          <p className="settings-hint">{t('后台 Agent 在哪个文件夹里干活，也就是它看得到的上下文。')}</p>
          {browsing
            ? <FolderPicker
              initialPath={settings.folder}
              disabled={disabled}
              onCancel={() => setBrowsing(false)}
              onPick={path => { setBrowsing(false); save({ folder: path }) }}
            />
            : <div className="folder-current">
              <code>{settings.folder || t('默认暂存目录')}</code>
              <button type="button" disabled={disabled} onClick={() => setBrowsing(true)}>
                {t('选择文件夹')}
              </button>
            </div>}
        </section>

        <section className="settings-group">
          <h4>{t('音色')}</h4>
          <p className="settings-hint">{t('助手说话的嗓音。英语默认用 Aiden 或 Jennifer。')}</p>
          <div className="settings-options">
            {settings.voices.map(option => <div
              key={option.id}
              className={`settings-option voice${settings.voice === option.id ? ' selected' : ''}`}
            >
              <button
                type="button"
                className="voice-pick"
                disabled={disabled}
                onClick={() => save({ voice: option.id })}
              >
                <b>{option.label}</b>
                <small>{option.detail}</small>
              </button>
              {setOutputVoice && <button
                type="button"
                className={`voice-sample${sampling === option.id ? ' playing' : ''}`}
                disabled={disabled || Boolean(sampling)}
                aria-label={t('试听 {name}', { name: option.label })}
                title={t('试听 {name}', { name: option.label })}
                onClick={async () => {
                  setSampling(option.id)
                  setError('')
                  try {
                    await setOutputVoice(option.id, { sample: true })
                  } catch (caught) {
                    setError(caught.message || t('试听失败'))
                  } finally {
                    setSampling('')
                  }
                }}
              >▶</button>}
            </div>)}
          </div>
        </section>

        <section className="settings-group">
          <h4>{t('断句')}</h4>
          <p className="settings-hint">{t('助手什么时候认为你说完了。改完会重启 Gateway。')}</p>
          <TurnSlider
            label={t('停顿多久算说完')}
            hint={t('调大一点，中途思考的停顿就不会被当成说完了。')}
            value={settings.turnSilenceMs}
            min={200}
            max={3000}
            step={100}
            disabled={disabled}
            format={value => t('{count} 毫秒', { count: value })}
            onCommit={value => save({ turnSilenceMs: value })}
          />
          <TurnSlider
            label={t('拾音灵敏度')}
            hint={t('调高一点，回声和环境音就不容易打断助手正在说的话。')}
            value={settings.turnThreshold}
            min={0}
            max={1}
            step={0.05}
            disabled={disabled}
            format={value => value.toFixed(2)}
            onCommit={value => save({ turnThreshold: value })}
          />
        </section>

        <section className="settings-group">
          <h4>{t('隐私')}</h4>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={Boolean(settings.summaryOnly)}
              disabled={disabled}
              onChange={event => save({ summaryOnly: event.target.checked })}
            />
            <span>
              <b>{t('只把一句话摘要发给语音模型')}</b>
              <small>{t('后台 Agent 的完整回复默认会发给语音服务商，好让它念出来。开启后只转发后台自己写的 VOICE: 那一行；没写就只说一句：完成了，结果在屏幕上。')}</small>
            </span>
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={Boolean(settings.webTools)}
              disabled={disabled}
              onChange={event => save({ webTools: event.target.checked })}
            />
            <span>
              <b>{t('让语音模型自己联网搜索')}</b>
              <small>{t('默认关闭：查资料都交给后台 Agent，它会读原文、交叉核实。打开后语音模型会自己用搜索引擎，更快但更浅，搜索词会发给搜索服务商。改完会重启 Gateway。')}</small>
            </span>
          </label>
        </section>

        <p className="settings-hint settings-footnote">
          {t('除了音色和聆听方式，这里的改动都会重启 Gateway，正在进行的任务会中断。')}
        </p>
      </>}
  </aside>
}
