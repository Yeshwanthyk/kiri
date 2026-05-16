'use client'

import { Check } from 'lucide-react'
import * as React from 'react'
import type { PendingQuestion } from '~/lib/contracts'

export function PendingQuestionPanel({
  pendingQuestion,
  onAnswer,
}: {
  pendingQuestion: PendingQuestion
  onAnswer: (answers: Record<string, string | string[]>) => Promise<void>
}) {
  const [answers, setAnswers] = React.useState<Record<string, string | string[]>>(() =>
    initialAnswers(pendingQuestion),
  )
  const [pending, setPending] = React.useState(false)

  React.useEffect(() => {
    setAnswers(initialAnswers(pendingQuestion))
  }, [pendingQuestion.requestId, pendingQuestion.questions])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    try {
      await onAnswer(answers)
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      className="pending-question-panel"
      onSubmit={(event) => void submit(event)}
      data-testid="pending-question"
    >
      <div className="pending-question-head">
        <strong>Claude needs input</strong>
      </div>
      {pendingQuestion.questions.map((question) => {
        const labelId = `pending-question-${question.id}-label`
        const hasOptions = question.options.length > 0
        return (
          <div key={question.id} className="pending-question-field">
            <span id={labelId}>{question.question}</span>
            {hasOptions && !question.multiSelect ? (
              <div
                className="pending-question-options"
                role="radiogroup"
                aria-labelledby={labelId}
              >
                {question.options.map((option) => {
                  const selected = answers[question.id] === option.label
                  return (
                    <button
                      key={option.label}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`pending-question-chip${selected ? ' selected' : ''}`}
                      onClick={() =>
                        setAnswers((current) => ({
                          ...current,
                          [question.id]: option.label,
                        }))
                      }
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            ) : hasOptions ? (
              <div
                className="pending-question-options"
                role="group"
                aria-labelledby={labelId}
              >
                {question.options.map((option) => {
                  const currentAnswer = answers[question.id]
                  const selected = Array.isArray(currentAnswer)
                    ? currentAnswer.includes(option.label)
                    : false
                  return (
                    <button
                      key={option.label}
                      type="button"
                      role="checkbox"
                      aria-checked={selected}
                      className={`pending-question-chip${selected ? ' selected' : ''}`}
                      onClick={() =>
                        setAnswers((current) => {
                          const existing = Array.isArray(current[question.id])
                            ? (current[question.id] as string[])
                            : []
                          const next = existing.includes(option.label)
                            ? existing.filter((item) => item !== option.label)
                            : [...existing, option.label]
                          return { ...current, [question.id]: next }
                        })
                      }
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            ) : (
              <input
                aria-labelledby={labelId}
                value={String(answers[question.id] ?? '')}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: value,
                  }))
                }}
              />
            )}
          </div>
        )
      })}
      <button type="submit" disabled={pending}>
        <Check size={14} />
        Answer
      </button>
    </form>
  )
}

function initialAnswers(pendingQuestion: PendingQuestion) {
  return initialPendingQuestionAnswers(pendingQuestion)
}

export function initialPendingQuestionAnswers(pendingQuestion: PendingQuestion) {
  return Object.fromEntries(
    pendingQuestion.questions.map((question) => [
      question.id,
      question.multiSelect ? [] : question.options[0]?.label ?? '',
    ]),
  )
}
