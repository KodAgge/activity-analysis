import { deepEqual } from '@tanstack/react-router'

/**
 * The plan view's URL state: which version of the goal is shown, and
 * which of its sessions is open.
 *
 * Optional, like Territory's region: the default is the pending version,
 * else the accepted one, else the newest, which only the payload knows,
 * so a bare `/plan` is the default rather than a URL to redirect away
 * from. A number no version has falls back to that default in the view,
 * where the versions are known, rather than here.
 *
 * TanStack Router's default search parser hands `?version=2` over as the
 * number 2, but a hand-typed `?version="2"` arrives as a string, so both
 * are read.
 */
export interface PlanSearch {
  version?: number
  /**
   * The session whose detail is open, by its id. Pushed when a session is
   * opened, so the browser's back button closes it and a link to one
   * workout can be shared. An id the shown version has no session for
   * opens nothing; that is decided in the view, where the sessions are.
   */
  session?: string
}

/** A session id as `plan/models.py`'s `ID_PATTERN` allows it. */
const SESSION_ID = /^[a-z0-9][a-z0-9-]*$/

export function validatePlanSearch(search: Record<string, unknown>): PlanSearch {
  const clean: PlanSearch = {}
  const raw = search.version
  const parsed = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw
  if (typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= 1) clean.version = parsed
  // The router's parser hands an all-digit id over as a number.
  const session = typeof search.session === 'number' ? String(search.session) : search.session
  if (typeof session === 'string' && SESSION_ID.test(session)) clean.session = session
  return clean
}

/**
 * The validated search when the raw one differs from it, so the route can
 * redirect an unknown key or a malformed version out of the address bar
 * the way `/territory` does; `null` when the URL already says what the
 * view shows.
 */
export function planSearchRedirectTarget(rawSearch: Record<string, unknown>): PlanSearch | null {
  const clean = validatePlanSearch(rawSearch)
  return deepEqual(rawSearch, clean) ? null : clean
}
