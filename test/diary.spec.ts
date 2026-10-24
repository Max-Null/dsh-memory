import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendEntry,
  dayFile,
  diaryDir,
  lastWriteAt,
  localDate,
  pointerLine,
  readDay,
  recentDates,
} from '../src/diary.ts'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-diary-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('日记存储（2026-10-24 日记机制设计方案 §四）', () => {
  it('目录落在 <DSH_HOME>/diary，与 storages 平级', () => {
    expect(diaryDir()).toBe(path.join(home, 'diary'))
  })

  it('空白 DSH_HOME 视为未设置，回退 ~/.dsh（纯计算，不碰盘）', () => {
    vi.stubEnv('DSH_HOME', '   ')
    expect(diaryDir()).toBe(path.join(os.homedir(), '.dsh', 'diary'))
  })

  it('展开前导波浪号', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    expect(diaryDir()).toBe(path.join(os.homedir(), 'env-dsh', 'diary'))
  })

  it('首次写入建文件，一级标题为日期、二级标题为时刻', () => {
    const at = new Date('2026-10-24T15:30:00').getTime()
    const result = appendEntry('今天他问了两件事。', at)

    expect(result.created).toBe(true)
    expect(result.date).toBe('2026-10-24')
    expect(result.file).toBe(dayFile('2026-10-24'))

    const text = readDay('2026-10-24')
    expect(text).toBeDefined()
    expect(text).toContain('# 2026-10-24')
    expect(text).toContain('## 15:30')
    expect(text).toContain('今天他问了两件事。')
  })

  it('同日多场对话追加，不覆盖前一段', () => {
    appendEntry('第一段。', new Date('2026-10-24T15:30:00').getTime())
    const second = appendEntry('第二段。', new Date('2026-10-24T21:10:00').getTime())

    expect(second.created).toBe(false)
    const text = readDay('2026-10-24') ?? ''
    expect(text).toContain('第一段。')
    expect(text).toContain('第二段。')
    expect(text.indexOf('第一段。')).toBeLessThan(text.indexOf('第二段。'))
  })

  it('按天分文件，recentDates 从新到旧', () => {
    appendEntry('前一天。', new Date('2026-10-23T09:00:00').getTime())
    appendEntry('后一天。', new Date('2026-10-24T09:00:00').getTime())

    expect(recentDates()).toEqual(['2026-10-24', '2026-10-23'])
    expect(recentDates(1)).toEqual(['2026-10-24'])
  })

  it('没有这一天时返回 undefined，不是空串', () => {
    expect(readDay('1999-01-01')).toBeUndefined()
  })

  it('空白内容被拒绝，且不建文件', () => {
    expect(() => appendEntry('   ')).toThrow()
    expect(recentDates()).toEqual([])
  })

  it('lastWriteAt 反映最后一次写入', () => {
    expect(lastWriteAt()).toBeUndefined()

    const at = new Date('2026-10-24T15:30:00').getTime()
    appendEntry('写一段。', at)
    expect(typeof lastWriteAt()).toBe('number')
  })

  it('指针行只有目录与日期，不含正文', () => {
    expect(pointerLine()).toContain('还没有任何一篇')

    appendEntry('今天他说手麻了，我有点担心。', new Date('2026-10-24T15:30:00').getTime())
    const line = pointerLine()
    expect(line).toContain(path.join(home, 'diary'))
    expect(line).toContain('2026-10-24')
    expect(line).not.toContain('手麻')
  })

  it('localDate 用本地时区的 YYYY-MM-DD', () => {
    expect(localDate(new Date('2026-01-05T23:59:00').getTime())).toBe('2026-01-05')
  })
})
