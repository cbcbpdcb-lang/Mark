#!/usr/bin/env node
// 从产品里的 PRESETS.direct_a 导出品牌 A 的 30 个问题，写成 questions.json。
// 用内部版 index.html：Dify 知识库是品牌官网原文，问题里要用真实品牌名才问得到。
//
//   node experiments/rag_eval/export_questions.mjs [--out 路径]

import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { HERE, INTERNAL_PAGE, launch, openApp } from './browser.mjs';

const { values: args } = parseArgs({ options: { out: { type: 'string', default: join(HERE, 'questions.json') }, page: { type: 'string', default: INTERNAL_PAGE } } });

const browser = await launch();
try {
  const page = await openApp(browser, args.page);
  const doc = await page.evaluate(() => {
    const p = PRESETS.direct_a;
    const d = presetData('direct_a');
    return {
      source: 'PRESETS.direct_a',
      query_set_version: 1,
      product: p.truth.entity_name,
      frozen: true,
      queries: d.queries.map(q => ({ id: q.id, stage: q.stage, group: q.group, text: q.text })),
    };
  });
  writeFileSync(args.out, JSON.stringify(doc, null, 2) + '\n');
  console.log(`导出 ${doc.queries.length} 个问题 → ${relative(process.cwd(), args.out) || args.out}`);
} finally {
  await browser.close();
}
