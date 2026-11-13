/** Official ask_user_question cards in the transcript and composer. */

const en = {
  'question.waiting': 'Waiting for your answer',
  'question.aborted': 'This question was cancelled before you answered.',
  'question.failed': 'This question could not be completed.',
  'question.skipped': 'Skipped',
  'question.answered': 'Answered',
  'question.multiSelect': 'You can choose more than one option.',
  'question.custom': 'Other: {text}',
} as const

const zh: Record<keyof typeof en, string> = {
  'question.waiting': '等待你的回答',
  'question.aborted': '这个问题在回答前被取消了。',
  'question.failed': '这个问题未能完成。',
  'question.skipped': '已跳过',
  'question.answered': '已回答',
  'question.multiSelect': '可以选择多个选项。',
  'question.custom': '其他：{text}',
}

export const question = { en, zh }
