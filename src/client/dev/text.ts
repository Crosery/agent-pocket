// Developer-mode strings (content/text/zh-CN/dev.json) joined into the shared text table at boot.
import devText from '../../../content/text/zh-CN/dev.json' with { type: 'json' }
import { CONTENT, flattenText } from '../../shared/content/index.ts'

export function installDevText(table: Record<string, string> = CONTENT.text): void {
  Object.assign(table, flattenText({ dev: devText }))
}
