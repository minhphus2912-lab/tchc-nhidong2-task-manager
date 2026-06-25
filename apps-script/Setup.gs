/**
 * ============================================================================
 *  KHỞI TẠO HỆ THỐNG — chạy MỘT LẦN sau khi dán code.
 * ----------------------------------------------------------------------------
 *  Mở Apps Script editor → chọn hàm runSetup → Run (cấp quyền lần đầu).
 *   - Tạo các sheet: Members, Tasks, Projects, KpiTargets, Config (kèm tiêu đề cột).
 *   - Nạp cấu hình KPI mặc định (Dễ=1, Bình thường=2, Nâng cao=3, Khó=4).
 *   - Tạo tài khoản Trưởng phòng đầu tiên (TP01 / PIN 123456 — đổi ngay sau khi vào).
 *
 *  runSetupWithDemo(): như trên + nạp dữ liệu mẫu (nhân sự, dự án, công việc, KPI)
 *  để xem thử ngay. Dùng khi muốn demo nhanh.
 *
 *  migrate_(): nếu đã có sheet Tasks cũ (16 cột), bổ sung 3 cột mới ở cuối
 *  (pauseHours, lastPausedAt, projectId) mà KHÔNG mất dữ liệu.
 * ============================================================================
 */

function runSetup() { setup_(false); }
function runSetupWithDemo() { setup_(true); }

/**
 * Xoá TOÀN BỘ task + dự án + mục tiêu KPI hiện tại rồi nạp lại DỮ LIỆU GỐC (demo).
 * GIỮ NGUYÊN tài khoản nhân sự & mã PIN. Gọi qua google.script.run.resetToSeed(token).
 * Yêu cầu quyền Trưởng phòng (an toàn — không để ai cũng xoá được dữ liệu).
 */
function resetToSeed(token) {
  requireHead_(token);
  var ss = getSS_();
  ensureSheet_(ss, SH_TASKS, TASK_COLS);
  ensureSheet_(ss, SH_PROJECTS, PROJECT_COLS);
  ensureSheet_(ss, SH_KPI, KPI_COLS);
  [SH_TASKS, SH_PROJECTS, SH_KPI].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh && sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1); // giữ dòng tiêu đề
  });
  migrate_();
  seedDemo_();   // nạp lại task/dự án/KPI gốc (members giữ nguyên)
  return { ok: true };
}

function setup_(withDemo) {
  var ss = getSS_();

  ensureSheet_(ss, SH_MEMBERS, MEMBER_COLS);
  ensureSheet_(ss, SH_TASKS, TASK_COLS);
  ensureSheet_(ss, SH_PROJECTS, PROJECT_COLS);
  ensureSheet_(ss, SH_KPI, KPI_COLS);
  ensureSheet_(ss, SH_CONFIG, ['key', 'value', 'mô tả']);
  ensureSheet_(ss, SH_CHATS, CHAT_COLS);
  ensureSheet_(ss, SH_MESSAGES, MSG_COLS);

  migrate_(); // đảm bảo sheet Tasks cũ có đủ cột mới

  seedConfig_();
  CacheService.getScriptCache().remove('CONFIG');

  // [TC-HC] Nhân sự mẫu ĐỦ CẤP cho Phòng Tổ chức Hành chính (đổi PIN/đổi tên sau khi đăng nhập).
  // Kiểm tra theo MÃ -> idempotent, re-run an toàn (ADMIN ẩn ở Script Property, không nằm ở đây).
  var mSheet = ss.getSheetByName(SH_MEMBERS);
  var _have = {};
  mSheet.getDataRange().getValues().slice(1).forEach(function (r) { _have[String(r[0]).trim().toUpperCase()] = true; });
  var _seedRoster = [
    ['TP01', 'Trưởng phòng', hashPin_('123456'), ROLE.HEAD,   'Trưởng phòng Tổ chức Hành chính', true, nowIso_(), '[]'],
    ['PP01', 'Phó phòng',    hashPin_('123456'), ROLE.DEPUTY, 'Phó phòng Tổ chức Hành chính',    true, nowIso_(), '[]'],
    ['NV01', 'Nhân viên 1',  hashPin_('123456'), ROLE.STAFF,  'Nhân viên Tổ chức Hành chính',    true, nowIso_(), '[]'],
    ['NV02', 'Nhân viên 2',  hashPin_('123456'), ROLE.STAFF,  'Nhân viên Tổ chức Hành chính',    true, nowIso_(), '[]']
  ];
  _seedRoster.forEach(function (r) { if (!_have[r[0]]) mSheet.appendRow(r); });
  Logger.log('Đã tạo nhân sự mẫu: TP01 (Trưởng phòng), PP01 (Phó phòng), NV01/NV02 (Nhân viên) — PIN 123456, HÃY ĐỔI.');

  if (withDemo) seedDemo_();

  formatSheets_(); // định dạng toàn bộ sheet cho gọn gàng, dễ nhìn

  Logger.log('runSetup hoàn tất. Deploy: New deployment → Web app → Execute as Me, Anyone (anonymous).');
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (headers && headers.length && sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sh;
}

/** Bổ sung cột mới vào sheet Tasks cũ (idempotent). */
function migrate_() {
  migrateSheetCols_(SH_TASKS, TASK_COLS);
  migrateSheetCols_(SH_MEMBERS, MEMBER_COLS); // thêm cột 'grants', 'avatar' cho sheet cũ
  // Tin nhắn/chat: tạo sheet nếu chưa có (deploy cũ chưa có 2 sheet này).
  var ss = getSS_();
  ensureSheet_(ss, SH_CHATS, CHAT_COLS);
  ensureSheet_(ss, SH_MESSAGES, MSG_COLS);
  migrateRolesAndConfig_();
  ensureAdminConfig_();   // ADMIN: credentials ở Script Property (ẨN), XOÁ khỏi sheet Members
  formatSheets_(); // mỗi lần migrate -> định dạng lại sheet cho gọn gàng
}

// ADMIN (quyền CAO NHẤT) KHÔNG được lưu trong sheet (data storage). Credentials -> Script Property ADMIN_PINHASH.
// Idempotent: dời PIN hiện tại (nếu ADMIN từng nằm trong sheet) sang Property rồi XOÁ dòng; nếu chưa có -> đặt mặc định 291219.
function ensureAdminConfig_() {
  var sp = PropertiesService.getScriptProperties();
  var ss = getSS_(); var sh = ss.getSheetByName(SH_MEMBERS);
  if (sh && sh.getLastRow() > 1) {
    var vals = sh.getDataRange().getValues();
    for (var i = vals.length - 1; i >= 1; i--) {            // duyệt ngược để xoá dòng an toàn
      if (String(vals[i][0]).trim().toUpperCase() === 'ADMIN') {
        if (!sp.getProperty('ADMIN_PINHASH')) sp.setProperty('ADMIN_PINHASH', String(vals[i][2] || '')); // giữ PIN ADMIN hiện tại (nếu đã đổi)
        sh.deleteRow(i + 1);                                  // XOÁ ADMIN khỏi sheet -> pass/info ADMIN không nằm ở nơi lưu trữ
        Logger.log('Đã chuyển ADMIN ra khỏi sheet Members (credentials lưu ở Script Property).');
      }
    }
  }
  if (!sp.getProperty('ADMIN_PINHASH')) sp.setProperty('ADMIN_PINHASH', hashPin_('291219'));
}

// Bề rộng cột gợi ý theo TÊN cột (px). Cột không liệt kê -> 110. Cột "dài/xấu" (avatar base64, pinHash, mô tả, link) -> hẹp + clip.
var COL_WIDTHS_ = {
  taskCode: 150, title: 250, description: 210, assigneeCode: 92, assigneeCodes: 150, difficulty: 95, kpiPoint: 62,
  status: 116, createdBy: 96, createdAt: 142, startedAt: 142, submittedAt: 142, completedAt: 142, lastPausedAt: 142,
  deadline: 106, reportLink: 150, completeLink: 150, note: 190, priority: 102, pauseHours: 82,
  projectId: 116, crewTask: 74, category: 132, phatSinh: 74, batchName: 150, startDate: 106, needSupport: 90, supportNote: 200,
  code: 86, name: 162, pinHash: 92, role: 132, active: 64, grants: 116, avatar: 90,
  id: 142, leadCode: 96, memberCodes: 172, eventDate: 110,
  memberCode: 116, target: 82,
  key: 172, value: 240, 'mô tả': 300,
  type: 76, chatId: 142, senderCode: 106, kind: 76, body: 320
};
// Định dạng MỌI sheet cho dễ nhìn: đóng băng + tô header, kẻ sọc xen kẽ, set bề rộng cột, clip tràn, định dạng ngày.
// Bọc try/catch từng thao tác -> mock harness (thiếu API định dạng) vẫn chạy bình thường, GAS thật áp dụng đầy đủ.
function formatSheets_() {
  var ss = getSS_();
  [SH_MEMBERS, SH_TASKS, SH_PROJECTS, SH_KPI, SH_CONFIG, SH_CHATS, SH_MESSAGES].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (!sh || sh.getLastColumn() === 0) return;
    var lastCol = sh.getLastColumn();
    var lastRow = Math.max(sh.getLastRow(), 1);
    var headers = [];
    try { headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (x) { return String(x).trim(); }); } catch (e) {}
    try { sh.setFrozenRows(1); } catch (e) {}
    try { sh.getRange(1, 1, 1, lastCol).setFontWeight('bold').setBackground('#17179d').setFontColor('#ffffff').setVerticalAlignment('middle').setHorizontalAlignment('left'); } catch (e) {}
    try { sh.setRowHeight(1, 32); } catch (e) {}
    // Kẻ sọc xen kẽ (gỡ banding cũ trước khi áp mới -> idempotent).
    try {
      var bs = sh.getBandings ? sh.getBandings() : [];
      for (var i = 0; i < bs.length; i++) { try { bs[i].remove(); } catch (e2) {} }
      sh.getRange(1, 1, lastRow, lastCol).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);
    } catch (e) {}
    // Không cho chữ tràn + canh giữa theo chiều dọc -> hàng đều, gọn.
    try { sh.getRange(1, 1, lastRow, lastCol).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP).setVerticalAlignment('middle'); } catch (e) {}
    // Bề rộng cột theo TÊN.
    for (var c = 0; c < headers.length; c++) {
      try { sh.setColumnWidth(c + 1, COL_WIDTHS_[headers[c]] || 110); } catch (e) {}
    }
    // Cột ngày-thuần (Sheets ép thành Date) -> định dạng yyyy-mm-dd.
    ['deadline', 'eventDate'].forEach(function (dc) {
      var idx = headers.indexOf(dc);
      if (idx >= 0 && lastRow > 1) { try { sh.getRange(2, idx + 1, lastRow - 1, 1).setNumberFormat('yyyy-mm-dd'); } catch (e) {} }
    });
  });
}

/** Di trú dữ liệu cũ (idempotent):
 *  - Vai trò 'MULTIMEDIA' đã bị xoá -> chuyển thành 'THANH_VIEN' (Thành viên Production Crew).
 *  - Tên đơn vị mặc định cũ 'Phòng Truyền thông' -> tên mới (CHỈ đổi nếu vẫn là mặc định cũ, không đè tuỳ biến). */
function migrateRolesAndConfig_() {
  var ss = getSS_();
  // 1) Vai trò Multimedia -> Thành viên
  var mSheet = ss.getSheetByName(SH_MEMBERS);
  if (mSheet && mSheet.getLastRow() > 1) {
    var mv = mSheet.getDataRange().getValues();
    var roleCol = MEMBER_COLS.indexOf('role'); // 0-based
    var changed = 0;
    for (var i = 1; i < mv.length; i++) {
      if (String(mv[i][roleCol]).trim() === 'MULTIMEDIA') {
        mSheet.getRange(i + 1, roleCol + 1).setValue('THANH_VIEN');
        changed++;
      }
    }
    if (changed) Logger.log('Di trú vai trò MULTIMEDIA -> THANH_VIEN: ' + changed + ' nhân sự.');
  }
  // 2) Đổi tên đơn vị mặc định cũ (không đè nếu đã tuỳ biến khác)
  var cSheet = ss.getSheetByName(SH_CONFIG);
  if (cSheet && cSheet.getLastRow() > 1) {
    var cv = cSheet.getDataRange().getValues();
    for (var j = 1; j < cv.length; j++) {
      if (String(cv[j][0]).trim() === 'DepartmentName' && /Truyền [Tt]hông/.test(String(cv[j][1]))) {
        cSheet.getRange(j + 1, 2).setValue('Phòng Tổ chức Hành chính - Bệnh viện Nhi Đồng 2');
        CacheService.getScriptCache().remove('CONFIG');
        Logger.log('Đã đổi tên đơn vị sang: Phòng Tổ chức Hành chính - Bệnh viện Nhi Đồng 2.');
      }
    }
  }
}
function migrateSheetCols_(sheetName, cols) {
  var sh = getSS_().getSheetByName(sheetName);
  if (!sh || sh.getLastRow() === 0) return;
  var header = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0]
                 .map(function (x) { return String(x).trim(); });
  var missing = cols.filter(function (c) { return header.indexOf(c) < 0; });
  if (missing.length) {
    sh.getRange(1, header.length + 1, 1, missing.length).setValues([missing]);
    Logger.log('Đã thêm cột mới vào ' + sheetName + ': ' + missing.join(', '));
  }
}

function seedConfig_() {
  var sh = getSS_().getSheetByName(SH_CONFIG);
  var existing = {};
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) existing[String(values[i][0]).trim()] = true;

  var defaults = [
    ['DepartmentName', 'Phòng Tổ chức Hành chính - Bệnh viện Nhi Đồng 2', 'Tên đơn vị hiển thị trên giao diện'],
    ['KPI_De', 1, 'Điểm KPI cho công việc mức Dễ'],
    ['KPI_BinhThuong', 2, 'Điểm KPI cho công việc mức Bình thường'],
    ['KPI_NangCao', 3, 'Điểm KPI cho công việc mức Nâng cao'],
    ['KPI_Kho', 4, 'Điểm KPI cho công việc mức Khó']
  ];
  defaults.forEach(function (d) { if (!existing[d[0]]) sh.appendRow(d); });
}

function seedDemo_() {
  var ss = getSS_();
  var mSheet = ss.getSheetByName(SH_MEMBERS);
  var tSheet = ss.getSheetByName(SH_TASKS);
  var pSheet = ss.getSheetByName(SH_PROJECTS);
  var kSheet = ss.getSheetByName(SH_KPI);

  // 1) Thành viên mẫu
  var have = {};
  readMembers_().forEach(function (m) { have[m.code] = true; });
  // [TC-HC] Chỉ nhân sự PHÒNG (đã gỡ Production Crew). Tên là placeholder, đổi sau.
  var demoMembers = [
    ['NV03', 'Nhân viên 3', hashPin_('123456'), ROLE.STAFF, 'Nhân viên Tổ chức Hành chính', true, nowIso_()],
    ['NV04', 'Nhân viên 4', hashPin_('123456'), ROLE.STAFF, 'Nhân viên Tổ chức Hành chính', true, nowIso_()]
  ];
  demoMembers.forEach(function (r) { if (!have[r[0]]) mSheet.appendRow(r); });

  // 2) Mục tiêu KPI mẫu (top-up theo từng mã — không trùng)
  var kHave = {};
  kSheet.getDataRange().getValues().slice(1).forEach(function (r) { if (r[0]) kHave[String(r[0]).trim()] = true; });
  [['NV01', 10], ['NV02', 10], ['NV03', 10], ['NV04', 8], ['PP01', 8], ['TP01', 6]]
    .forEach(function (r) { if (!kHave[r[0]]) kSheet.appendRow(r); });

  // 3) Dự án mẫu (thêm nếu chưa có id đó)
  var pHave = {};
  pSheet.getDataRange().getValues().slice(1).forEach(function (r) { if (r[0]) pHave[String(r[0]).trim()] = true; });
  if (!pHave['PRJ-2026-001']) {
    pSheet.appendRow(projToRow_({
      id: 'PRJ-2026-001', name: 'Kiện toàn hồ sơ nhân sự Quý 3/2026', leadCode: 'PP01',
      memberCodes: ['NV01', 'NV02', 'NV03'], eventDate: '2026-09-05',
      status: PROJ_STATUS.ACTIVE, createdAt: nowIso_()
    }));
  }

  // 4) Công việc mẫu (top-up theo từng taskCode — re-run an toàn, thêm task crew vào sheet cũ).
  function iso(d) { return d + 'T09:00:00+07:00'; }
  var pts = difficultyPoints_();
  function buildRow(o) {
    var base = {
      taskCode: '', title: '', description: '', assigneeCode: '', difficulty: '',
      kpiPoint: 0, status: STATUS.TODO, createdBy: 'TP01', createdAt: nowIso_(),
      deadline: '', startedAt: '', submittedAt: '', completedAt: '', reportLink: '',
      note: '', priority: 'Bình thường', pauseHours: 0, lastPausedAt: '', projectId: '', crewTask: false
    };
    for (var k in o) base[k] = o[k];
    base.kpiPoint = pts[base.difficulty] || 0;
    return base;
  }
  var tHave = {};
  tSheet.getDataRange().getValues().slice(1).forEach(function (r) { if (r[0]) tHave[String(r[0]).trim()] = true; });

  var taskObjs = [
    // --- Việc hằng ngày (KHÔNG thuộc dự án) ---
    ({ taskCode: '20260601-001-NV01', title: 'Soạn thông báo nội bộ tháng 6', description: 'Phát hành các khoa/phòng', assigneeCode: 'NV01', difficulty: 'Dễ', status: STATUS.DONE, createdBy: 'TP01', createdAt: iso('2026-06-01'), deadline: '2026-06-03', startedAt: iso('2026-06-01'), submittedAt: iso('2026-06-02'), completedAt: iso('2026-06-04') }),
    ({ taskCode: '20260602-001-NV02', title: 'Cập nhật hồ sơ nhân sự Quý 2', description: 'Rà soát, bổ sung hồ sơ', assigneeCode: 'NV02', difficulty: 'Nâng cao', status: STATUS.DONE, createdBy: 'TP01', createdAt: iso('2026-06-02'), deadline: '2026-06-05', startedAt: iso('2026-06-02'), submittedAt: iso('2026-06-04'), completedAt: iso('2026-06-05') }),
    ({ taskCode: '20260603-001-NV03', title: 'Lập lịch trực hành chính tháng 7', description: 'Phân ca trực, gửi duyệt', assigneeCode: 'NV03', difficulty: 'Khó', status: STATUS.RUNNING, createdBy: 'PP01', createdAt: iso('2026-06-03'), deadline: '2026-06-10', startedAt: iso('2026-06-03'), priority: 'Cao' }),
    ({ taskCode: '20260604-001-NV01', title: 'Số hóa công văn đến/đi', description: 'Quét và lưu trữ điện tử', assigneeCode: 'NV01', difficulty: 'Nâng cao', status: STATUS.TODO, createdBy: 'TP01', createdAt: iso('2026-06-04'), deadline: '2026-06-12' }),
    ({ taskCode: '20260605-001-NV02', title: 'Tổng hợp chấm công tuần 24', description: 'File Google Sheet', assigneeCode: 'NV02', difficulty: 'Bình thường', status: STATUS.SENT, createdBy: 'PP01', createdAt: iso('2026-06-05'), deadline: '2026-06-09', startedAt: iso('2026-06-05'), submittedAt: iso('2026-06-07') }),

    // --- Việc thuộc dự án PRJ-2026-001 ---
    ({ taskCode: '2026-001-001-NV01', title: 'Rà soát hợp đồng lao động', description: 'Đối chiếu, cập nhật phụ lục', assigneeCode: 'NV01', difficulty: 'Nâng cao', status: STATUS.RUNNING, createdBy: 'PP01', createdAt: iso('2026-06-05'), deadline: '2026-08-20', priority: 'Cao', projectId: 'PRJ-2026-001' }),
    ({ taskCode: '2026-001-002-NV02', title: 'Xây dựng quy trình tiếp nhận nhân sự', description: 'Sơ đồ + biểu mẫu', assigneeCode: 'NV02', difficulty: 'Bình thường', status: STATUS.TODO, createdBy: 'PP01', createdAt: iso('2026-06-05'), deadline: '2026-08-15', projectId: 'PRJ-2026-001' }),
    ({ taskCode: '2026-001-003-NV03', title: 'Báo cáo biên chế & vị trí việc làm', description: 'Trình Ban Giám đốc', assigneeCode: 'NV03', difficulty: 'Khó', status: STATUS.RUNNING, createdBy: 'PP01', createdAt: iso('2026-06-05'), deadline: '2026-09-05', priority: 'Khẩn cấp', projectId: 'PRJ-2026-001' })
  ];
  taskObjs.forEach(function (o) { if (!tHave[o.taskCode]) tSheet.appendRow(taskToRow_(buildRow(o))); });
}
