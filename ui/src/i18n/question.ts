/** Official ask_user_question cards in the transcript and composer. */

const en = {
  'question.waiting': 'Waiting for your answer',
  'question.aborted': 'This question was cancelled before you answered.',
  'question.failed': 'This question could not be completed.',
  'question.skipped': 'Skipped',
  'question.answered': 'Answered',
  'question.multiSelect': 'You can choose more than one option.',
  'question.custom': 'Other: {text}',
  'question.customLabel': 'Other',
  'question.customPlaceholder': 'Type a custom answer',
  'question.skip': 'Skip',
  'question.submit': 'Submit answers',
  'question.submitting': 'Submitting…',
  'question.submitFailed': 'The answer could not be submitted.',
  'question.incomplete': 'Answer or skip each question before submitting.',
} as const

const zh: Record<keyof typeof en, string> = {
  'question.waiting': '等待你的回答',
  'question.aborted': '这个问题在回答前被取消了。',
  'question.failed': '这个问题未能完成。',
  'question.skipped': '已跳过',
  'question.answered': '已回答',
  'question.multiSelect': '可以选择多个选项。',
  'question.custom': '其他：{text}',
  'question.customLabel': '其他',
  'question.customPlaceholder': '输入自定义回答',
  'question.skip': '跳过',
  'question.submit': '提交回答',
  'question.submitting': '正在提交…',
  'question.submitFailed': '回答未能提交。',
  'question.incomplete': '请先回答或跳过每一项再提交。',
}

export const question = { en, zh }
