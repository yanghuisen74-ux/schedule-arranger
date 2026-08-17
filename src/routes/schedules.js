const { Hono } = require('hono');
const { html } = require('hono/html');
const layout = require('../layout');
const ensureAuthenticated = require('../middlewares/ensure-authenticated');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ log: ['query'] });
const { z } = require('zod');
const { zValidator } = require('@hono/zod-validator');
const { HTTPException } = require('hono/http-exception');

const app = new Hono();

app.use(ensureAuthenticated())

const scheduleIdValidator = zValidator(
  'param',
  z.object({
    scheduleId: z.string().uuid(),
  }),
  (result) => {
    if (!result.success) {
      throw new HTTPException(400, { message: 'URL の形式が正しくありません。' });
    }
  }
);

const scheduleFormValidator = zValidator(
  'form',
  z.object({
    scheduleName: z.string(),
    memo: z.string(),
    candidates: z.string(),
  }),
  (result) => {
    if (!result.success) {
      throw new HTTPException(400, { message: '入力された情報が不十分または正しくありません' });
    }
  }
);

async function createCandidates(candidateNames, scheduleId) {
  const candidates = candidateNames.map((candidateName) => ({
    candidateName,
    scheduleId,
  }));
  await prisma.candidate.createMany({
    data: candidates,
  });
}

function parseCandidateNames(candidatesStr) {
  return candidatesStr
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

app.get('/new', (c) => {
  return c.html(
    layout(
      c,
      '予定の作成',
      html`
        <div class="row justify-content-center my-4">
          <div class="col-12 col-md-10 col-lg-8">
            <div class="card shadow-sm border-0 rounded-4">
              <div class="card-body p-4 p-md-5">
                <div class="mb-4">
                  <h2 class="h4 fw-bold mb-1">新しい予定を作成</h2>
                  <p class="text-secondary small mb-0">
                    予定の詳細と候補日程を入力してください。
                  </p>
                </div>

                <form method="post" action="/schedules">
                  <!-- 予定名 -->
                  <div class="mb-4">
                    <label class="form-label fw-semibold d-flex align-items-center gap-2">
                      予定名
                      <span class="badge bg-danger-subtle text-danger-emphasis border border-danger-subtle small">必須</span>
                    </label>
                    <input
                      type="text"
                      name="scheduleName"
                      class="form-control form-control-lg fs-6"
                      placeholder="例: プロジェクトキックオフミーティング"
                      required
                    />
                  </div>

                  <!-- メモ -->
                  <div class="mb-4">
                    <label class="form-label fw-semibold d-flex align-items-center gap-2">
                      メモ
                      <span class="badge bg-secondary-subtle text-secondary-emphasis border border-secondary-subtle small">任意</span>
                    </label>
                    <textarea
                      name="memo"
                      rows="3"
                      class="form-control"
                      placeholder="例: オンライン（Zoom）で開催予定です。各自事前に資料をご確認ください。"
                    ></textarea>
                    <div class="form-text">参加者に伝えたい共有事項やアジェンダを入力できます。</div>
                  </div>

                  <!-- 候補日程 -->
                  <div class="mb-4">
                    <label class="form-label fw-semibold d-flex align-items-center gap-2">
                      候補日程
                      <span class="badge bg-danger-subtle text-danger-emphasis border border-danger-subtle small">必須</span>
                    </label>
                    <textarea
                      name="candidates"
                      rows="5"
                      class="form-control font-monospace"
                      placeholder="9/1(月) 19:00〜&#10;9/2(火) 20:00〜&#10;9/5(金) 18:30〜"
                      required
                    ></textarea>
                    <div class="form-text">改行して複数の日時を入力してください。</div>
                  </div>

                  <!-- 送信ボタン -->
                  <div class="d-flex justify-content-end gap-2 pt-2 border-top">
                    <a href="/" class="btn btn-outline-secondary px-4 fw-semibold">
                      キャンセル
                    </a>
                    <button class="btn btn-primary px-4 fw-semibold shadow-sm" type="submit">
                      予定を作成する
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      `,
    ),
  );
});

app.post('/', scheduleFormValidator, async (c) => {
  const { user } = c.get('session') ?? {};
  const body = c.req.valid('form');

  // 予定を登録
  const { scheduleId } = await prisma.schedule.create({
    data: {
      scheduleId: randomUUID(),
      scheduleName: body.scheduleName.slice(0, 255) || '（名称未設定）',
      memo: body.memo,
      createdBy: user.id,
      updatedAt: new Date(),
    },
  });

  // 候補日程を登録
  const candidateNames = parseCandidateNames(body.candidates);
  await createCandidates(candidateNames, scheduleId);

  // 作成した予定のページにリダイレクト
  return c.redirect('/schedules/' + scheduleId);
});

app.get('/:scheduleId', scheduleIdValidator, async (c) => {
  const { user } = c.get('session') ?? {};
  const schedule = await prisma.schedule.findUnique({
    where: { scheduleId: c.req.valid('param').scheduleId },
    include: {
      user: {
        select: {
          userId: true,
          username: true,
        },
      },
    },
  });

  if(!schedule) {
    return c.notFound();
  }

  const candidates = await prisma.candidate.findMany({
    where: { scheduleId: schedule.scheduleId },
    orderBy: { candidateId: 'asc' },
  });

  // データベースからその予定のすべての出欠を取得する
  const availabilities = await prisma.availability.findMany({
    where: { scheduleId: schedule.scheduleId },
    orderBy: { candidateId: 'asc' },
    include: {
      user: {
        select: {
          userId: true,
          username: true,
        },
      },
    },
  });
  // 出欠 MapMap を作成する
  const availabilityMapMap = new Map(); // key: userId, value: Map(key: candidateId, value: availability)
  availabilities.forEach((a) => {
    const map = availabilityMapMap.get(a.user.userId) || new Map();
    map.set(a.candidateId, a.availability);
    availabilityMapMap.set(a.user.userId, map);
  });

  // 閲覧ユーザと出欠に紐づくユーザからユーザ Map を作る
  const userMap = new Map(); // key: userId, value: User
  userMap.set(parseInt(user.id, 10), {
    isSelf: true,
    userId: parseInt(user.id, 10),
    username: user.username,
  });
  availabilities.forEach((a) => {
    userMap.set(a.user.userId, {
      isSelf: parseInt(user.id, 10) === a.user.userId, // 閲覧ユーザ自身であるかを示す真偽値
      userId: a.user.userId,
      username: a.user.username,
    });
  });
 
  // 全ユーザ、全候補で二重ループしてそれぞれの出欠の値がない場合には、「欠席」を設定する
  const users = Array.from(userMap.values());
  users.forEach((u) => {
    candidates.forEach((c) => {
      const map = availabilityMapMap.get(u.userId) || new Map();
      const a = map.get(c.candidateId) || 0; // デフォルト値は 0 を使用
      map.set(c.candidateId, a);
      availabilityMapMap.set(u.userId, map);
    });
  });

  // コメント取得
  const comments = await prisma.comment.findMany({
    where: { scheduleId: schedule.scheduleId },
  });
  const commentMap = new Map(); //key: userId, value: comment
  comments.forEach((comment) => {
    commentMap.set(comment.userId, comment.comment);
  });

  const buttonStyles = ['btn-danger', 'btn-secondary', 'btn-success'];

return c.html(
    layout(
      c,
      `予定: ${schedule.scheduleName}`,
      html`
        <div class="my-4 d-flex flex-column gap-4">
          <!-- 予定詳細カード -->
          <div class="card border-0 shadow-sm rounded-4 overflow-hidden">
            <div class="card-header bg-body-tertiary border-bottom py-3 px-4 d-flex justify-content-between align-items-center flex-wrap gap-2">
              <h1 class="h4 fw-bold mb-0 text-body-emphasis">${schedule.scheduleName}</h1>
              ${isMine(user.id, schedule)
                ? html`
                    <a
                      href="/schedules/${schedule.scheduleId}/edit"
                      class="btn btn-outline-primary btn-sm fw-semibold d-inline-flex align-items-center gap-1 shadow-sm"
                    >
                      <i class="bi bi-pencil"></i>
                      この予定を編集する
                    </a>
                  `
                : ''}
            </div>
            <div class="card-body p-4">
              <p class="mb-0 text-secondary" style="white-space: pre-wrap; line-height: 1.7;">${schedule.memo}</p>
            </div>
            <div class="card-footer bg-light-subtle text-muted small py-2 px-4 border-top">
              作成者: <span class="fw-semibold text-dark">${schedule.user.username}</span>
            </div>
          </div>

          <!-- 出欠表セクション -->
          <div class="card border-0 shadow-sm rounded-4 p-4">
            <div class="mb-3">
              <h2 class="h5 fw-bold mb-1">出欠表</h2>
              <p class="text-muted small mb-0">ご自身の列のボタンをクリックして出欠ステータスを変更できます。</p>
            </div>

            <div class="table-responsive rounded-3 border">
              <table class="table table-hover align-middle text-center mb-0">
                <thead class="table-light border-bottom">
                  <tr>
                    <th scope="col" class="py-3 px-4 text-start text-secondary" style="min-width: 180px;">候補日程</th>
                    ${users.map(
                      (user) => html`
                        <th scope="col" class="py-3 px-3 text-secondary ${user.isSelf ? 'table-primary bg-opacity-25 fw-bold' : ''}" style="min-width: 110px;">
                          ${user.username}
                          ${user.isSelf ? html`<span class="badge bg-primary ms-1 small">あなた</span>` : ''}
                        </th>
                      `,
                    )}
                  </tr>
                </thead>
                <tbody>
                  ${candidates.map(
                    (candidate) => html`
                      <tr>
                        <th scope="row" class="py-3 px-4 text-start fw-normal text-body-emphasis">
                          ${candidate.candidateName}
                        </th>
                        ${users.map((user) => {
                          const availability = availabilityMapMap
                            .get(user.userId)
                            .get(candidate.candidateId);
                          const availabilityLabels = ['欠', '？', '出'];
                          const label = availabilityLabels[availability];
                          return html`
                            <td class="p-2 ${user.isSelf ? 'table-primary bg-opacity-10' : ''}">
                              ${user.isSelf
                                ? html`<button
                                    data-schedule-id="${schedule.scheduleId}"
                                    data-user-id="${user.userId}"
                                    data-candidate-id="${candidate.candidateId}"
                                    data-availability="${availability}"
                                    class="availability-toggle-button btn btn-md fw-bold shadow-sm ${buttonStyles[
                                      availability
                                    ]}"
                                    style="width: 48px; height: 48px;"
                                  >
                                    ${label}
                                  </button>`
                                : html`<span class="fs-5 fw-bold text-secondary">${label}</span>`}
                            </td>
                          `;
                        })}
                      </tr>
                    `,
                  )}
                  <!-- コメント行 -->
                  <tr class="table-light border-top">
                    <th scope="row" class="py-3 px-4 text-start text-secondary">コメント</th>
                    ${users.map((user) => {
                      const comment = commentMap.get(user.userId);
                      return html`
                        <td class="py-3 px-2 align-top ${user.isSelf ? 'table-primary bg-opacity-10' : ''}">
                          <div class="d-flex flex-column align-items-center gap-2">
                            <p class="mb-0 small text-break" style="min-height: 20px;">
                              <span id="${user.isSelf ? 'self-comment' : ''}">
                                ${comment || html`<span class="text-muted fst-italic">--</span>`}
                              </span>
                            </p>
                            ${user.isSelf
                              ? html`
                                  <button
                                    data-schedule-id="${schedule.scheduleId}"
                                    data-user-id="${user.userId}"
                                    id="self-comment-button"
                                    class="btn btn-outline-secondary btn-sm px-2 py-1"
                                  >
                                    <i class="bi bi-chat-dots me-1"></i>編集
                                  </button>
                                `
                              : ''}
                          </div>
                        </td>
                      `;
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `,
    ),
  );
});

function isMine(userId, schedule) {
  return schedule && parseInt(schedule.createdBy, 10) === parseInt(userId, 10);
}

app.get('/:scheduleId/edit', scheduleIdValidator, async (c) => {
  const { user } = c.get('session') ?? {};
  const schedule = await prisma.schedule.findUnique({
    where: { scheduleId: c.req.valid('param').scheduleId },
  });
  if (!isMine(user.id, schedule)) {
    return c.notFound();
  }

  const candidates = await prisma.candidate.findMany({
    where: { scheduleId: schedule.scheduleId },
    orderBy: { candidateId: 'asc' },
  });

return c.html(
    layout(
      c,
      `予定の編集: ${schedule.scheduleName}`,
      html`
        <div class="row justify-content-center my-4">
          <div class="col-12 col-md-10 col-lg-8 d-flex flex-column gap-4">
            <!-- 編集フォームカード -->
            <div class="card shadow-sm border-0 rounded-4">
              <div class="card-body p-4 p-md-5">
                <div class="mb-4">
                  <h2 class="h4 fw-bold mb-1">予定の編集</h2>
                  <p class="text-secondary small mb-0">
                    予定の情報変更や候補日程の追加ができます。
                  </p>
                </div>

                <form
                  method="post"
                  action="/schedules/${schedule.scheduleId}/update"
                >
                  <!-- 予定名 -->
                  <div class="mb-4">
                    <label class="form-label fw-semibold d-flex align-items-center gap-2">
                      予定名
                      <span class="badge bg-danger-subtle text-danger-emphasis border border-danger-subtle small">必須</span>
                    </label>
                    <input
                      type="text"
                      name="scheduleName"
                      class="form-control form-control-lg fs-6"
                      value="${schedule.scheduleName}"
                      required
                    />
                  </div>

                  <!-- メモ -->
                  <div class="mb-4">
                    <label class="form-label fw-semibold d-flex align-items-center gap-2">
                      メモ
                      <span class="badge bg-secondary-subtle text-secondary-emphasis border border-secondary-subtle small">任意</span>
                    </label>
                    <textarea name="memo" rows="3" class="form-control">${schedule.memo}</textarea>
                  </div>

                  <!-- 候補日程エリア -->
                  <div class="mb-4">
                    <label class="form-label fw-semibold mb-2">既存の候補日程</label>
                    <ul class="list-group rounded-3 mb-3">
                      ${candidates.map(
                        (candidate) =>
                          html`<li class="list-group-item bg-body-tertiary text-secondary py-2 px-3">
                            <i class="bi bi-calendar-event me-2 text-muted"></i>${candidate.candidateName}
                          </li>`,
                      )}
                    </ul>

                    <label class="form-label fw-semibold d-flex align-items-center gap-2 mt-3">
                      候補日程の追加
                      <span class="badge bg-secondary-subtle text-secondary-emphasis border border-secondary-subtle small">任意</span>
                    </label>
                    <textarea
                      name="candidates"
                      rows="4"
                      class="form-control font-monospace"
                      placeholder="9/10(水) 19:00〜&#10;9/12(金) 20:00〜"
                    ></textarea>
                    <div class="form-text">改行して入力すると、新しい日程を追加できます。</div>
                  </div>

                  <!-- 保存・キャンセルボタン -->
                  <div class="d-flex justify-content-end gap-2 pt-3 border-top">
                    <a
                      href="/schedules/${schedule.scheduleId}"
                      class="btn btn-outline-secondary px-4 fw-semibold"
                    >
                      キャンセル
                    </a>
                    <button type="submit" class="btn btn-primary px-4 fw-semibold shadow-sm">
                      <i class="bi bi-pencil me-1"></i>以上の内容で保存する
                    </button>
                  </div>
                </form>
              </div>
            </div>

            <!-- Danger Zone（削除エリア） -->
            <div class="card border-danger-subtle bg-danger-subtle bg-opacity-25 rounded-4 shadow-sm">
              <div class="card-body p-4 d-flex flex-column flex-sm-row justify-content-between align-items-sm-center gap-3">
                <div>
                  <h3 class="h6 fw-bold text-danger mb-1">
                    <i class="bi bi-exclamation-triangle-fill me-1"></i>危険な変更
                  </h3>
                  <p class="text-secondary small mb-0">
                    この予定と参加者のすべての出欠データが完全に削除されます。
                  </p>
                </div>
                <form
                  method="post"
                  action="/schedules/${schedule.scheduleId}/delete"
                  onsubmit="return confirm('本当にこの予定を削除しますか？この操作は取り消せません。');"
                  class="flex-shrink-0"
                >
                  <button type="submit" class="btn btn-outline-danger fw-semibold px-3 shadow-sm">
                    <i class="bi bi-trash me-1"></i>予定を削除する
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      `,
    ),
  );
});

app.post('/:scheduleId/update', scheduleIdValidator, scheduleFormValidator, async (c) => {
  const { user } = c.get('session') ?? {};
  const schedule = await prisma.schedule.findUnique({
    where: { scheduleId: c.req.valid('param').scheduleId },
  });
  if (!isMine(user.id, schedule)) {
    return c.notFound();
  }

  const body = c.req.valid('form');
  const updatedSchedule = await prisma.schedule.update({
    where: { scheduleId: schedule.scheduleId },
    data: {
      scheduleName: body.scheduleName.slice(0, 255) || '（名称未設定）',
      memo: body.memo,
      updatedAt: new Date(),
    },
  });

  // 候補が追加されているかチェック
  const candidateNames = parseCandidateNames(body.candidates);
  if (candidateNames.length) {
    await createCandidates(candidateNames, updatedSchedule.scheduleId);
  }

  return c.redirect('/schedules/' + updatedSchedule.scheduleId);
});

// 予定と、予定に関するデータをすべて削除する関数
async function deleteScheduleAggregate(scheduleId) {
  await prisma.availability.deleteMany({ where: { scheduleId } });
  await prisma.candidate.deleteMany({ where: { scheduleId } });
  await prisma.comment.deleteMany({ where: { scheduleId } });
  await prisma.schedule.delete({ where: { scheduleId } });
}

app.deleteScheduleAggregate = deleteScheduleAggregate; // テストでも使えるように

app.post('/:scheduleId/delete', scheduleIdValidator, async (c) => {
  const { user } = c.get('session') ?? {};
  const schedule = await prisma.schedule.findUnique({
    where: { scheduleId: c.req.valid('param').scheduleId },
  });
  if (!isMine(user.id, schedule)) {
    return c.notFound();
  }

  await deleteScheduleAggregate(schedule.scheduleId);
  return c.redirect('/');
});

module.exports = app;