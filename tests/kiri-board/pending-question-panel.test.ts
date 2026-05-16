import { describe, expect, it } from 'vitest'
import type { PendingQuestion } from '~/lib/contracts'
import { initialPendingQuestionAnswers } from '~/components/kiri-board/pending-question-panel'

describe('pending question panel helpers', () => {
  it('builds the answer payload shape for choice, multi-choice, and freeform questions', () => {
    const pendingQuestion: PendingQuestion = {
      requestId: 'request-1',
      questions: [
        {
          id: 'runtime',
          header: 'Runtime',
          question: 'Pick runtime',
          options: [
            { label: 'Codex', description: 'Use Codex' },
            { label: 'Claude', description: 'Use Claude' },
          ],
          multiSelect: false,
        },
        {
          id: 'checks',
          header: 'Checks',
          question: 'Pick checks',
          options: [
            { label: 'typecheck', description: 'Run TypeScript' },
            { label: 'e2e', description: 'Run browser tests' },
          ],
          multiSelect: true,
        },
        {
          id: 'notes',
          header: 'Notes',
          question: 'Anything else?',
          options: [],
          multiSelect: false,
        },
      ],
    }

    expect(initialPendingQuestionAnswers(pendingQuestion)).toEqual({
      runtime: 'Codex',
      checks: [],
      notes: '',
    })
  })
})
