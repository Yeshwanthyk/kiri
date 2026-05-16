import type { ReviewTarget } from '~/lib/contracts'

export function codexReviewDisplayText(target: ReviewTarget) {
  if (target.type === 'baseBranch') return `/review base ${target.branch}`
  return '/review'
}
