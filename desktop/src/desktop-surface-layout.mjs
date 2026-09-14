export const DESKTOP_ORB_WIDTH = 172
export const DESKTOP_ORB_HEIGHT = 204
export const DESKTOP_PANEL_WIDTH = 440
export const DESKTOP_PANEL_HEIGHT = 680
export const DESKTOP_TASK_SURFACE_WIDTH = 360
export const DESKTOP_TASK_CARD_HEIGHT = 54
export const DESKTOP_TASK_CARD_GAP = 8
export const DESKTOP_TASK_STACK_PADDING = 8
export const DESKTOP_TASK_STACK_LIFT = 14
// The caption bubble sits between the orb and the task cards and tucks under
// the orb by the same lift. Keep in sync with .desktop-caption in styles.css.
export const DESKTOP_CAPTION_HEIGHT = 50
const DESKTOP_TASK_PLACEMENT_HYSTERESIS = 48

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(minimum, value), maximum)
}

export function desktopConversationPanelBounds({
  orbBounds,
  workArea,
  width = DESKTOP_PANEL_WIDTH,
  height = DESKTOP_PANEL_HEIGHT,
}) {
  const panelWidth = Math.min(width, workArea.width)
  const panelHeight = Math.min(height, workArea.height)
  return {
    // Grow towards the left from the orb's right edge. The orb therefore
    // returns to the same visual anchor when the panel is collapsed.
    x: clamp(
      orbBounds.x + orbBounds.width - panelWidth,
      workArea.x,
      workArea.x + workArea.width - panelWidth,
    ),
    y: clamp(
      orbBounds.y,
      workArea.y,
      workArea.y + workArea.height - panelHeight,
    ),
    width: panelWidth,
    height: panelHeight,
  }
}

export function desktopOrbAnchorFromPanel({ bounds, workArea }) {
  return {
    x: clamp(
      bounds.x + bounds.width - DESKTOP_ORB_WIDTH,
      workArea.x,
      workArea.x + workArea.width - DESKTOP_ORB_WIDTH,
    ),
    y: clamp(
      bounds.y,
      workArea.y,
      workArea.y + workArea.height - DESKTOP_ORB_HEIGHT,
    ),
    width: DESKTOP_ORB_WIDTH,
    height: DESKTOP_ORB_HEIGHT,
  }
}

function normalizedTaskCount(value) {
  return Math.max(0, Math.floor(Number(value) || 0))
}

function hasSurface(taskCount, caption) {
  return normalizedTaskCount(taskCount) > 0 || caption === true
}

function taskSurfaceHeight(taskCount, caption = false) {
  const count = normalizedTaskCount(taskCount)
  const captionHeight = caption === true
    ? DESKTOP_CAPTION_HEIGHT - DESKTOP_TASK_STACK_LIFT
    : 0
  if (count === 0) return captionHeight
  const stackHeight = (
    count * DESKTOP_TASK_CARD_HEIGHT
    + Math.max(0, count - 1) * DESKTOP_TASK_CARD_GAP
    + DESKTOP_TASK_STACK_PADDING * 2
  )
  // Only the element that touches the orb tucks under it.
  return caption === true
    ? captionHeight + stackHeight
    : stackHeight - DESKTOP_TASK_STACK_LIFT
}

export function desktopSurfaceSize(taskCount, {
  caption = false,
  taskAreaHeight = Number.POSITIVE_INFINITY,
  workAreaHeight,
} = {}) {
  if (!hasSurface(taskCount, caption)) {
    return { width: DESKTOP_ORB_WIDTH, height: DESKTOP_ORB_HEIGHT }
  }
  const legacyAvailableHeight = Number.isFinite(workAreaHeight)
    ? Math.max(0, workAreaHeight - DESKTOP_ORB_HEIGHT)
    : Number.POSITIVE_INFINITY
  const availableHeight = Number.isFinite(taskAreaHeight)
    ? Math.max(0, taskAreaHeight)
    : legacyAvailableHeight
  return {
    width: DESKTOP_TASK_SURFACE_WIDTH,
    height: DESKTOP_ORB_HEIGHT + Math.min(
      taskSurfaceHeight(taskCount, caption),
      availableHeight,
    ),
  }
}

export function desktopOrbBounds(bounds, {
  taskCount = 0,
  caption = false,
  placement = 'below',
  orbOffsetX,
} = {}) {
  const surface = hasSurface(taskCount, caption)
  const horizontalOffset = surface && Number.isFinite(orbOffsetX)
    ? orbOffsetX
    : Math.round((bounds.width - DESKTOP_ORB_WIDTH) / 2)
  return {
    x: bounds.x + horizontalOffset,
    y: surface && placement === 'above'
      ? bounds.y + bounds.height - DESKTOP_ORB_HEIGHT
      : bounds.y,
    width: DESKTOP_ORB_WIDTH,
    height: DESKTOP_ORB_HEIGHT,
  }
}

export function desktopTaskPlacement({
  orbBounds,
  workArea,
  taskCount,
  caption = false,
  placement = 'below',
}) {
  if (!hasSurface(taskCount, caption)) return placement
  const requestedHeight = taskSurfaceHeight(taskCount, caption)
  const availableAbove = Math.max(0, orbBounds.y - workArea.y)
  const availableBelow = Math.max(0, (
    workArea.y + workArea.height
    - orbBounds.y - orbBounds.height
  ))
  const aboveFits = availableAbove >= requestedHeight
  const belowFits = availableBelow >= requestedHeight

  if (aboveFits && !belowFits) return 'above'
  if (belowFits && !aboveFits) return 'below'

  // Prefer the roomier side, but retain the current direction in a narrow
  // band around the screen midpoint so a small drag does not make cards jump.
  if (
    Math.abs(availableAbove - availableBelow)
    <= DESKTOP_TASK_PLACEMENT_HYSTERESIS
  ) return placement
  return availableAbove > availableBelow ? 'above' : 'below'
}

export function desktopSurfaceLayout({
  bounds,
  currentTaskCount = 0,
  currentCaption = false,
  taskCount = 0,
  caption = false,
  placement = 'below',
  orbOffsetX,
  workArea,
}) {
  const currentOrb = desktopOrbBounds(bounds, {
    taskCount: currentTaskCount,
    caption: currentCaption,
    placement,
    orbOffsetX,
  })
  const orbBounds = {
    ...currentOrb,
    x: clamp(
      currentOrb.x,
      workArea.x,
      workArea.x + workArea.width - DESKTOP_ORB_WIDTH,
    ),
    y: clamp(
      currentOrb.y,
      workArea.y,
      workArea.y + workArea.height - DESKTOP_ORB_HEIGHT,
    ),
  }
  const nextPlacement = desktopTaskPlacement({
    orbBounds,
    workArea,
    taskCount,
    caption,
    placement,
  })
  const taskAreaHeight = nextPlacement === 'above'
    ? orbBounds.y - workArea.y
    : workArea.y + workArea.height - orbBounds.y - orbBounds.height
  const size = desktopSurfaceSize(taskCount, { caption, taskAreaHeight })
  const surface = hasSurface(taskCount, caption)
  const x = clamp(
    orbBounds.x - Math.round((size.width - DESKTOP_ORB_WIDTH) / 2),
    workArea.x,
    workArea.x + workArea.width - size.width,
  )
  const y = surface && nextPlacement === 'above'
    ? orbBounds.y + DESKTOP_ORB_HEIGHT - size.height
    : orbBounds.y

  return {
    bounds: { x, y, width: size.width, height: size.height },
    placement: nextPlacement,
    orbOffsetX: surface ? orbBounds.x - x : 0,
  }
}
