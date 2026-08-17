const { Hono } = require('hono');
const { html } = require('hono/html');
const layout = require('../layout');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ log: ['query'] });

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault('Asia/Tokyo');
const app = new Hono();

function scheduleTable(schedules) {
  return html`
    <div class="table-responsive shadow-sm rounded border">
      <table class="table table-hover table-striped align-middle mb-0">
        <thead class="table-light border-bottom">
          <tr>
            <th scope="col" class="py-3 ps-4 text-secondary">予定名</th>
            <th scope="col" class="py-3 text-secondary" style="width: 220px;">更新日時</th>
          </tr>
        </thead>
        <tbody>
          ${schedules.map(
            (schedule) => html`
              <tr>
                <td class="ps-4">
                  <a
                    href="/schedules/${schedule.scheduleId}"
                    class="text-decoration-none fw-semibold text-primary"
                  >
                    ${schedule.scheduleName}
                  </a>
                </td>
                <td class="text-muted small">${schedule.formattedUpdatedAt}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

app.get('/', async (c) => {
  const { user } = c.get('session') ?? {};
  const schedules = user
    ? await prisma.schedule.findMany({
      where: { createdBy: user.id },
      orderBy: { updatedAt: 'desc' },
    })
  : [];
  // それぞれの予定の日程をフォーマットして見やすくする。
schedules.forEach((schedule) => {
    schedule.formattedUpdatedAt = dayjs(schedule.updatedAt).tz().format('YYYY/MM/DD HH:mm');
  });

  return c.html(
    layout(
      c,
      null,
      html`
        <!-- ヒーローセクション -->
        <div class="my-4">
          <div class="p-5 bg-body-tertiary rounded-4 shadow-sm border">
            <h1 class="display-6 fw-bold text-body-emphasis mb-3">予定調整くん</h1>
            <p class="lead text-secondary mb-0">
              予定調整くんは、GitHubで認証でき、予定を作って出欠が取れるサービスです。
            </p>
          </div>
        </div>

        ${user
          ? html`
              <div class="my-4 d-flex flex-column gap-4">
                <!-- 作成ボタンエリア -->
                <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
                  <div>
                    <h2 class="h4 fw-bold mb-1">新しい予定を作成</h2>
                    <p class="text-muted small mb-0">日程候補を設定して共有リンクを発行します</p>
                  </div>
                  <a class="btn btn-primary px-4 py-2 fw-semibold shadow-sm" href="/schedules/new">
                    ＋ 予定を作る
                  </a>
                </div>

                <!-- 予定一覧エリア -->
                ${schedules.length > 0
                  ? html`
                      <div class="card border-0 shadow-sm rounded-4">
                        <div class="card-body p-4">
                          <h2 class="h5 fw-bold mb-3 text-secondary">あなたの作った予定一覧</h2>
                          ${scheduleTable(schedules)}
                        </div>
                      </div>
                    `
                  : ''}
              </div>
            `
          : ''}
      `,
    ),
  );
});

module.exports = app;