/**
 * ============================================================================
 *  QUẢN LÝ NHÂN SỰ & CÔNG VIỆC — PHÒNG TỔ CHỨC HÀNH CHÍNH - BỆNH VIỆN NHI ĐỒNG 2
 *  Backend Google Apps Script (Web App) — lưu trữ trên Google Sheets
 * ----------------------------------------------------------------------------
 *  Kiến trúc:
 *   - Deploy: Execute as ME (USER_DEPLOYING) + Who has access: ANYONE/ANONYMOUS
 *     => người dùng KHÔNG cần đăng nhập Google. Tự quản lý phiên bằng token.
 *   - doGet trả HtmlOutput + setXFrameOptionsMode(ALLOWALL) để nhúng Google Sites.
 *   - MỌI kiểm tra quyền nằm ở SERVER (client chỉ là UI, không phải hàng rào).
 *   - Ngày giờ truyền qua google.script.run dưới dạng CHUỖI ISO (không truyền Date).
 *   - Timezone cố định Asia/Ho_Chi_Minh (không DST) — luôn dùng offset +07:00.
 *   - Sinh mã trong LockService, counter monotonic theo ngày/dự án (đọc từ sheet).
 *
 *  CÁC HÀM GỌI TỪ CLIENT (google.script.run):
 *   bootstrap, login, logout, getState,
 *   createTask, transitionTask, updateTaskNote,
 *   createProject, updateProject, completeProject,
 *   upsertMember, setKpiTarget, changePassword, aiGenerate
 *
 *  CHẠY MỘT LẦN: runSetup() hoặc runSetupWithDemo()  (xem Setup.gs)
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Hằng số
// ---------------------------------------------------------------------------
var TZ = 'Asia/Ho_Chi_Minh';

var SH_MEMBERS = 'Members';
var SH_TASKS   = 'Tasks';
var SH_PROJECTS = 'Projects';
var SH_KPI     = 'KpiTargets';
var SH_CONFIG  = 'Config';
var SH_CHATS    = 'Chats';
var SH_MESSAGES = 'Messages';
var CHAT_COLS = ['id', 'type', 'name', 'memberCodes', 'createdBy', 'createdAt'];
var MSG_COLS  = ['id', 'chatId', 'senderCode', 'kind', 'body', 'createdAt'];

var ROLE = {
  ADMIN: 'ADMIN', // Quản trị hệ thống — quyền CAO NHẤT (trên cả Trưởng phòng), thấy & quản lý toàn bộ Phòng + Crew.
  HEAD: 'TRUONG_PHONG', DEPUTY: 'PHO_PHONG', STAFF: 'CHUYEN_VIEN',
  LEAD: 'LEAD_PROD', QUAY: 'SUBLEAD_QUAY', CHUP: 'SUBLEAD_CHUP', MEMBER: 'THANH_VIEN'
};
var ALL_ROLES = [ROLE.ADMIN, ROLE.HEAD, ROLE.DEPUTY, ROLE.STAFF, ROLE.LEAD, ROLE.QUAY, ROLE.CHUP, ROLE.MEMBER];
// [TC-HC] Production Crew ĐÃ GỠ khỏi bản này: CREW_ROLES rỗng -> isCrewRole_ luôn false,
// mọi nhánh silo crew trở thành nhánh chết (không người dùng nào thuộc crew). Chỉ còn 1 phòng.
var CREW_ROLES = [];
var CREW_MGR_ROLES = [ROLE.ADMIN, ROLE.HEAD, ROLE.DEPUTY, ROLE.LEAD, ROLE.QUAY, ROLE.CHUP];
var CREW_VIEW_ROLES = [ROLE.ADMIN, ROLE.HEAD, ROLE.DEPUTY, ROLE.LEAD, ROLE.QUAY, ROLE.CHUP, ROLE.MEMBER];

var STATUS = {
  TODO:    'Chưa bắt đầu',
  RUNNING: 'Đang chạy',
  PENDING: 'Tạm dừng',
  SENT:    'Đã gửi',
  DONE:    'Hoàn thành',
  UNCLAIMED: 'Chưa đăng ký'   // việc do Leader/Trưởng/Phó tạo nhưng CHƯA giao cho ai (chờ nhận)
};
// Quy trình chuẩn 5 bước (dùng cho thanh tiến độ + force-status). 'Chưa đăng ký' KHÔNG nằm trong quy trình.
var STATUS_ORDER = [STATUS.TODO, STATUS.RUNNING, STATUS.PENDING, STATUS.SENT, STATUS.DONE];

var PRIORITY_ORDER = ['Thấp', 'Bình thường', 'Cao', 'Khẩn cấp'];

var PROJ_STATUS = { ACTIVE: 'Đang thực hiện', COMPLETED: 'Đã hoàn thành' };

// Thứ tự cột — KHÔNG đổi nếu đã có dữ liệu. Thêm cột mới ở CUỐI.
var MEMBER_COLS = ['code', 'name', 'pinHash', 'role', 'title', 'active', 'createdAt', 'grants', 'avatar'];
// Quyền có thể GIAO thêm (ngoài vai trò). Mở rộng được trong tương lai.
var GRANT_KEYS = ['MANAGE_CREW'];
var TASK_COLS = ['taskCode', 'title', 'description', 'assigneeCode', 'difficulty',
                 'kpiPoint', 'status', 'createdBy', 'createdAt', 'deadline',
                 'startedAt', 'submittedAt', 'completedAt', 'reportLink', 'note',
                 'priority', 'pauseHours', 'lastPausedAt', 'projectId', 'crewTask',
                 'category', 'completeLink', 'phatSinh', 'batchName', 'assigneeCodes',
                 'startDate', 'needSupport', 'supportNote'];
// Phần phụ công việc (Trung Tâm Truyền thông).
var WORK_CATEGORIES = ['Admin', 'Design', 'Digital marketing', 'Facebook', 'TikTok', 'Multimedia', 'PR', 'Internal communications'];
var PROJECT_COLS = ['id', 'name', 'leadCode', 'memberCodes', 'eventDate', 'status', 'createdAt'];
var KPI_COLS = ['memberCode', 'target'];

var DIFFICULTY_ORDER = ['Dễ', 'Bình thường', 'Nâng cao', 'Khó'];
var DIFFICULTY_CONFIG_KEY = {
  'Dễ': 'KPI_De', 'Bình thường': 'KPI_BinhThuong',
  'Nâng cao': 'KPI_NangCao', 'Khó': 'KPI_Kho'
};
var DIFFICULTY_DEFAULT = { 'Dễ': 1, 'Bình thường': 2, 'Nâng cao': 3, 'Khó': 4 };

var SESSION_TTL = 21600; // 6 giờ (giới hạn CacheService)

// ---------------------------------------------------------------------------
// Phục vụ giao diện
// ---------------------------------------------------------------------------
function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Quản lý công việc — Phòng Tổ chức Hành chính - Bệnh viện Nhi Đồng 2')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Cho phép tách CSS/JS ra file riêng và chèn nguyên văn vào Index.html */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// ---------------------------------------------------------------------------
// JSON API (doPost) — cho client CHẠY NGOÀI GAS (vd GitHub Pages) gọi qua fetch.
// Gửi: POST với Content-Type text/plain (request "đơn giản" → KHÔNG preflight CORS),
//      body = JSON { fn: "createTask", args: [token, payload] }.
// Trả: JSON { ok:true, result } hoặc { ok:false, error }.
// CHỈ cho gọi các hàm trong API_FUNCTIONS (đúng tập mà google.script.run dùng) —
// mọi kiểm tra quyền/đăng nhập vẫn nằm trong từng hàm (token-based).
// ---------------------------------------------------------------------------
function apiFunctions_() {
  return {
    bootstrap: bootstrap, login: login, logout: logout, getState: getState,
    createTask: createTask, transitionTask: transitionTask, updateTaskNote: updateTaskNote,
    updateTask: updateTask, deleteTask: deleteTask, setTaskDeadline: setTaskDeadline, setTaskSupport: setTaskSupport,
    createProject: createProject, updateProject: updateProject, completeProject: completeProject, deleteProject: deleteProject,
    changePassword: changePassword, setKpiTarget: setKpiTarget, setCrewRole: setCrewRole, setGrant: setGrant,
    saveAvatar: saveAvatar, upsertMember: upsertMember, deleteMember: deleteMember, addCrewMember: addCrewMember, updateCrewMember: updateCrewMember,
    listChats: listChats, getMessages: getMessages, sendMessage: sendMessage, createDM: createDM, createGroup: createGroup,
    renameGroup: renameGroup, addChatMembers: addChatMembers, removeChatMember: removeChatMember, deleteGroup: deleteGroup,
    aiGenerate: aiGenerate, resetToSeed: resetToSeed
  };
}
function doPost(e) {
  var out;
  try {
    ensureMigrated_();
    var body = (e && e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : {};
    var fn = String(body.fn || '');
    var args = Array.isArray(body.args) ? body.args : [];
    var f = apiFunctions_()[fn];
    if (!f) throw err_('Hàm API không hợp lệ: ' + fn);
    out = { ok: true, result: f.apply(null, args) };
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Tiện ích chung
// ---------------------------------------------------------------------------
function getSS_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
}

var KNOWN_SHEETS = [SH_MEMBERS, SH_TASKS, SH_PROJECTS, SH_KPI, SH_CONFIG, SH_CHATS, SH_MESSAGES];
function getSheet_(name) {
  var ss = getSS_();
  var sh = ss.getSheetByName(name);
  if (!sh && KNOWN_SHEETS.indexOf(name) >= 0) {
    // Tự khởi tạo lần đầu (KHÔNG nạp dữ liệu mẫu) để web app chạy được ngay sau khi deploy,
    // kể cả khi chưa chạy runSetup thủ công. Tạo bảng + cấu hình + tài khoản TP01.
    setup_(false);
    sh = ss.getSheetByName(name);
  }
  if (!sh) throw err_('Chưa khởi tạo bảng "' + name + '". Hãy chạy hàm runSetup() một lần trong trình chỉnh sửa Apps Script.');
  return sh;
}

function err_(msg) { return new Error(msg); }
function uuid_() { return Utilities.getUuid(); }

/** Chuỗi ISO thời điểm hiện tại theo giờ VN, vd "2026-06-19T14:30:00+07:00" */
function nowIso_() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss") + '+07:00';
}
/** Ngày hôm nay theo giờ VN, "yyyy-MM-dd" */
function todayYmd_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

/** Google Sheets TỰ ĐỘNG ép chuỗi ngày ("2026-09-05") thành đối tượng Date khi ghi.
 *  Khi đọc lại sẽ là Date -> String(Date) ra "Sat Sep 05 2026..." làm hỏng parse ở client.
 *  Helper này chuẩn hoá: Date -> chuỗi đúng định dạng; chuỗi/khác -> giữ nguyên. */
function isDateObj_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
function cellToDateStr_(v, withTime) {
  if (v === '' || v === null || v === undefined) return '';
  if (isDateObj_(v)) {
    return withTime ? (Utilities.formatDate(v, TZ, "yyyy-MM-dd'T'HH:mm:ss") + '+07:00')
                    : Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  return String(v);
}

function normalizeDate_(s) {
  s = String(s || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function hashPin_(pin) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, 'pttt::' + String(pin), Utilities.Charset.UTF_8);
  return Utilities.base64Encode(raw);
}

// ---------------------------------------------------------------------------
// Cấu hình (Config sheet) — có cache
// ---------------------------------------------------------------------------
function readConfig_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('CONFIG');
  if (cached) return JSON.parse(cached);

  var sh = getSheet_(SH_CONFIG);
  var values = sh.getDataRange().getValues();
  var cfg = {};
  for (var i = 1; i < values.length; i++) {
    var k = String(values[i][0]).trim();
    if (k) cfg[k] = values[i][1];
  }
  cache.put('CONFIG', JSON.stringify(cfg), 300);
  return cfg;
}

function getConfigValue_(key, fallback) {
  var cfg = readConfig_();
  return (cfg[key] !== undefined && cfg[key] !== '') ? cfg[key] : fallback;
}

function difficultyPoints_() {
  var cfg = readConfig_();
  var map = {};
  DIFFICULTY_ORDER.forEach(function (label) {
    var v = Number(cfg[DIFFICULTY_CONFIG_KEY[label]]);
    map[label] = isNaN(v) ? DIFFICULTY_DEFAULT[label] : v;
  });
  return map;
}

function difficultyList_() {
  var pts = difficultyPoints_();
  return DIFFICULTY_ORDER.map(function (label) { return { label: label, points: pts[label] }; });
}

function clearConfigCache() { CacheService.getScriptCache().remove('CONFIG'); }

// ---------------------------------------------------------------------------
// Thành viên (Members sheet)
// ---------------------------------------------------------------------------
function readMembers_() {
  var sh = getSheet_(SH_MEMBERS);
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!String(row[0]).trim()) continue;
    out.push({
      code: String(row[0]).trim(),
      name: String(row[1]).trim(),
      pinHash: String(row[2]),
      role: String(row[3]).trim(),
      title: String(row[4]).trim(),
      active: row[5] === true || String(row[5]).toUpperCase() === 'TRUE',
      createdAt: String(row[6] || ''),
      grants: parseGrants_(row[7]),
      avatar: String(row[8] || '')
    });
  }
  return out;
}

function parseGrants_(raw) {
  raw = String(raw == null ? '' : raw).trim();
  if (!raw) return [];
  try { var a = JSON.parse(raw); return Array.isArray(a) ? a : []; }
  catch (e) { return raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean); }
}

function publicMember_(m) {
  if (!m) return null;
  return { code: m.code, name: m.name, role: m.role, title: m.title, active: m.active, grants: m.grants || [], avatar: m.avatar || '' };
}

// ---------------------------------------------------------------------------
// Phiên đăng nhập (tự quản lý — KHÔNG dựa Google session)
// ---------------------------------------------------------------------------
// ADMIN (quyền cao nhất) KHÔNG nằm trong sheet Members. Credentials lưu ở Script Property ADMIN_PINHASH (ẩn khỏi mọi nơi lưu trữ dữ liệu).
var ADMIN_CODE = 'ADMIN';
function adminUser_() { return { code: ADMIN_CODE, name: 'ADMIN', pinHash: '', role: ROLE.ADMIN, title: 'Quản trị hệ thống', active: true, grants: [], avatar: '' }; }
function adminPinHash_() { try { return PropertiesService.getScriptProperties().getProperty('ADMIN_PINHASH') || hashPin_('291219'); } catch (e) { return hashPin_('291219'); } }
function isAdminCode_(code) { return String(code || '').trim().toUpperCase() === ADMIN_CODE; }

function login(memberCode, pin) {
  var code = String(memberCode).trim().toUpperCase();
  var m;
  if (isAdminCode_(code)) {
    if (adminPinHash_() !== hashPin_(pin)) throw err_('Mã cá nhân (PIN) không đúng.');
    m = adminUser_();
  } else {
    var members = readMembers_();
    m = members.filter(function (x) { return x.code.toUpperCase() === code && x.active; })[0];
    if (!m) throw err_('Tài khoản không tồn tại hoặc đã bị khóa.');
    if (m.pinHash !== hashPin_(pin)) throw err_('Mã cá nhân (PIN) không đúng.');
  }

  var token = uuid_();
  var cache = CacheService.getScriptCache();
  cache.put('S_' + token, m.code, SESSION_TTL);
  // MỘT tài khoản = MỘT phiên hoạt động: đăng nhập mới ĐÁ phiên cũ.
  // KHÔNG xoá cache phiên cũ ở đây — để getUser_ còn so khớp được và ném SESSION_KICKED
  // (phân biệt với SESSION_EXPIRED). Cache phiên cũ tự hết hạn theo TTL.
  try {
    PropertiesService.getScriptProperties().setProperty('TOK_' + m.code, token);
  } catch (e) { /* không chặn đăng nhập nếu property lỗi */ }
  return { token: token, user: publicMember_(m) };
}

/** Lấy người dùng từ token; LUÔN đọc lại vai trò từ DB để bảo đảm chính xác.
 *  Nếu token KHÔNG phải phiên đang hoạt động của tài khoản (đã bị đăng nhập nơi khác) -> ném SESSION_KICKED. */
function getUser_(token) {
  if (!token) return null;
  var cache = CacheService.getScriptCache();
  var code = cache.get('S_' + token);
  if (!code) return null;
  // Phiên bị "đá": có phiên mới hơn cho cùng tài khoản.
  try {
    var activeTok = PropertiesService.getScriptProperties().getProperty('TOK_' + code);
    if (activeTok && activeTok !== token) throw err_('SESSION_KICKED');
  } catch (e) { if (e && /SESSION_KICKED/.test(e.message)) throw e; /* property lỗi -> bỏ qua check */ }
  cache.put('S_' + token, code, SESSION_TTL); // gia hạn
  touchPresence_(code); // cập nhật "online" mỗi lần gọi API (kể cả poll)
  if (isAdminCode_(code)) return publicMember_(adminUser_()); // ADMIN: dựng user tổng hợp, KHÔNG đọc sheet
  var m = readMembers_().filter(function (x) { return x.code === code && x.active; })[0];
  return m ? publicMember_(m) : null;
}

// ----- Hiện diện (online) — dựa trên "last seen" lưu ở CacheService (không tốn quota Properties) -----
var ONLINE_WINDOW_MS = 150000; // 2.5 phút: poll nền 30s + chat 6s -> còn hoạt động trong cửa sổ này = online
function touchPresence_(code) { try { CacheService.getScriptCache().put('SEEN_' + code, String(new Date().getTime()), 1800); } catch (e) {} }
function presenceMap_(codes) {
  var out = {}, now = new Date().getTime(), cache = CacheService.getScriptCache();
  (codes || []).forEach(function (c) {
    if (!c || out[c] !== undefined) return;
    var seen = cache.get('SEEN_' + c);
    out[c] = !!(seen && (now - Number(seen) < ONLINE_WINDOW_MS));
  });
  return out;
}

function requireUser_(token) {
  var u = getUser_(token);
  if (!u) throw err_('SESSION_EXPIRED');
  return u;
}
function isAdmin_(u) { return u && u.role === ROLE.ADMIN; }
function isManager_(u) { return u.role === ROLE.ADMIN || u.role === ROLE.HEAD || u.role === ROLE.DEPUTY; }
function isHead_(u) { return u.role === ROLE.ADMIN || u.role === ROLE.HEAD; }
function isCrewRole_(role) { return CREW_ROLES.indexOf(role) >= 0; }
function hasGrant_(u, key) { return !!(u && u.grants && u.grants.indexOf(key) >= 0); }
// [TC-HC] Production Crew đã gỡ: không ai quản lý/xem crew (luôn false) -> ẩn mọi giao diện/bảng crew.
function canManageCrew_(u) { return false; }
function canViewCrew_(u) { return false; }
// "Trưởng" của crew: quản trị toàn bộ crew (không bị giới hạn theo cấp). = Trưởng/Phó phòng + người được giao MANAGE_CREW.
function isCrewAdmin_(u) { return isManager_(u) || hasGrant_(u, 'MANAGE_CREW'); }
// Phạm vi xem dữ liệu PHÒNG: all (Trưởng phòng) / allButHigher (Phó phòng) / own (Chuyên viên) / none (vai trò thuần crew).
function deptScopeOf_(role) {
  if (role === ROLE.ADMIN) return 'all';
  if (role === ROLE.HEAD) return 'all';
  if (role === ROLE.DEPUTY) return 'allButHigher';
  if (role === ROLE.STAFF) return 'own';
  return 'none';
}
function hasDeptBoard_(role) { return deptScopeOf_(role) !== 'none'; }
function requireCrewManager_(token) {
  var u = requireUser_(token);
  if (!canManageCrew_(u)) throw err_('Bạn không có quyền quản lý Production Crew.');
  return u;
}
// Ai được SỬA/XOÁ một task: task crew -> quản lý crew; còn lại -> Trưởng/Phó phòng.
function canManageTask_(u, t) { return t.crewTask ? canManageCrew_(u) : isManager_(u); }
// Danh sách NGƯỜI THỰC HIỆN của 1 task (hỗ trợ nhiều người). Tương thích ngược: chưa có assigneeCodes -> suy ra từ assigneeCode.
function taskAssignees_(t) {
  if (t && t.assigneeCodes && t.assigneeCodes.length) return t.assigneeCodes;
  return (t && t.assigneeCode) ? [t.assigneeCode] : [];
}
function isTaskAssignee_(t, code) { return taskAssignees_(t).indexOf(code) >= 0; }
// Chính chủ được SỬA task daily (không thuộc dự án) của mình: chuyên viên Phòng (own) hoặc thành viên crew.
function isOwnEditable_(u, t) { return isTaskAssignee_(t, u.code) && !t.projectId && (deptScopeOf_(u.role) === 'own' || isCrewRole_(u.role)); }
function canEditTask_(u, t) { return canManageTask_(u, t) || isOwnEditable_(u, t); }

// Phân cấp hiển thị: số NHỎ = cấp CAO. Vai trò thấp KHÔNG xem được thông tin vai trò cao.
// Hai "silo" độc lập: Phòng (HEAD/DEPUTY/STAFF) và Production Crew (LEAD/QUAY/CHUP/MEMBER).
var ROLE_RANK = {
  ADMIN: -1,
  TRUONG_PHONG: 0, PHO_PHONG: 1, CHUYEN_VIEN: 2,
  LEAD_PROD: 0, SUBLEAD_QUAY: 1, SUBLEAD_CHUP: 1, THANH_VIEN: 3
};
function rankOf_(role) { var r = ROLE_RANK[role]; return (r === undefined) ? 9 : r; }
function siloOf_(role) { return isCrewRole_(role) ? 'crew' : 'dept'; }
// So sánh thứ bậc CHỈ trong cùng silo (khác silo = không so sánh authority).
function outranksWithinSilo_(viewerRole, targetRole) {
  return siloOf_(viewerRole) === siloOf_(targetRole) && rankOf_(targetRole) < rankOf_(viewerRole);
}
function requireManager_(token) {
  var u = requireUser_(token);
  if (!isManager_(u)) throw err_('Chỉ Trưởng phòng / Phó phòng mới có quyền thực hiện thao tác này.');
  return u;
}
function requireHead_(token) {
  var u = requireUser_(token);
  if (!isHead_(u)) throw err_('Chỉ Trưởng phòng mới có quyền thực hiện thao tác này.');
  return u;
}
function logout(token) {
  if (token) {
    var cache = CacheService.getScriptCache();
    var code = cache.get('S_' + token);
    cache.remove('S_' + token);
    // Dọn token đang hoạt động nếu đúng là phiên này (tránh "đá" nhầm lần đăng nhập kế tiếp).
    try {
      if (code) {
        var sp = PropertiesService.getScriptProperties();
        if (sp.getProperty('TOK_' + code) === token) sp.deleteProperty('TOK_' + code);
      }
    } catch (e) {}
  }
  return true;
}

// ---------------------------------------------------------------------------
// Công việc (Tasks sheet)
// ---------------------------------------------------------------------------
function taskObjFromRow_(row) {
  var o = {};
  TASK_COLS.forEach(function (c, i) { o[c] = (row[i] === undefined || row[i] === null) ? '' : row[i]; });
  o.kpiPoint = Number(o.kpiPoint) || 0;
  o.pauseHours = Number(o.pauseHours) || 0;
  o.crewTask = (o.crewTask === true || String(o.crewTask).toUpperCase() === 'TRUE');
  o.phatSinh = (o.phatSinh === true || String(o.phatSinh).toUpperCase() === 'TRUE');
  o.needSupport = (o.needSupport === true || String(o.needSupport).toUpperCase() === 'TRUE');
  var dateOnly = { deadline: 1, startDate: 1 };
  var dateTime = { createdAt: 1, startedAt: 1, submittedAt: 1, completedAt: 1, lastPausedAt: 1 };
  ['taskCode', 'title', 'description', 'assigneeCode', 'difficulty', 'status',
   'createdBy', 'createdAt', 'deadline', 'startedAt', 'submittedAt', 'completedAt',
   'reportLink', 'note', 'priority', 'lastPausedAt', 'projectId', 'category', 'completeLink', 'batchName',
   'startDate', 'supportNote']
    .forEach(function (c) {
      if (dateOnly[c]) o[c] = cellToDateStr_(o[c], false);
      else if (dateTime[c]) o[c] = cellToDateStr_(o[c], true);
      else o[c] = String(o[c]);
    });
  if (!o.projectId) o.projectId = null;
  // NHIỀU người thực hiện: assigneeCodes lưu dạng JSON array trong 1 ô. Tương thích ngược:
  // dòng cũ chưa có cột này -> suy ra [assigneeCode]. Không cần backfill dữ liệu.
  var _ac = [];
  if (o.assigneeCodes) {
    try { _ac = JSON.parse(o.assigneeCodes); }
    catch (e) { _ac = String(o.assigneeCodes).split(',').map(function (s) { return s.trim(); }); }
  }
  if (!(_ac instanceof Array)) _ac = [];
  _ac = _ac.map(function (x) { return String(x).trim(); }).filter(Boolean);
  if (!_ac.length && o.assigneeCode) _ac = [String(o.assigneeCode).trim()];
  o.assigneeCodes = _ac;
  return o;
}
function taskToRow_(t) {
  return TASK_COLS.map(function (c) {
    var v = t[c];
    if (c === 'assigneeCodes') return JSON.stringify((v instanceof Array) ? v : (v ? [v] : []));
    if (v === undefined || v === null) return '';
    return v;
  });
}
function readTasks_() {
  var sh = getSheet_(SH_TASKS);
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    if (!String(values[i][0]).trim()) continue;
    out.push(taskObjFromRow_(values[i]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dự án (Projects sheet)
// ---------------------------------------------------------------------------
function projObjFromRow_(row) {
  var memberCodes = [];
  try {
    var raw = String(row[3] || '').trim();
    if (raw) memberCodes = raw.charAt(0) === '[' ? JSON.parse(raw) : raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  } catch (e) { memberCodes = []; }
  return {
    id: String(row[0] || '').trim(),
    name: String(row[1] || '').trim(),
    leadCode: String(row[2] || '').trim(),
    memberCodes: memberCodes,
    eventDate: cellToDateStr_(row[4], false),
    status: String(row[5] || '').trim() || PROJ_STATUS.ACTIVE,
    createdAt: cellToDateStr_(row[6], true)
  };
}
function projToRow_(p) {
  return [p.id, p.name, p.leadCode, JSON.stringify(p.memberCodes || []),
          p.eventDate || '', p.status || PROJ_STATUS.ACTIVE, p.createdAt || nowIso_()];
}
function readProjects_() {
  var sh = getSheet_(SH_PROJECTS);
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    if (!String(values[i][0]).trim()) continue;
    out.push(projObjFromRow_(values[i]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mục tiêu KPI (KpiTargets sheet)
// ---------------------------------------------------------------------------
function readKpiTargets_() {
  var sh = getSheet_(SH_KPI);
  var values = sh.getDataRange().getValues();
  var out = {};
  for (var i = 1; i < values.length; i++) {
    var c = String(values[i][0] || '').trim();
    if (!c) continue;
    out[c] = Number(values[i][1]) || 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// API: bootstrap & getState
// ---------------------------------------------------------------------------
/** Dữ liệu công khai cho màn hình đăng nhập (KHÔNG chứa pin). */
// Tăng MIG_VERSION mỗi khi cần migrate_() chạy lại trên dữ liệu ĐÃ deploy.
// v12: thêm cột avatar, MULTIMEDIA -> THANH_VIEN, đổi tên đơn vị.
// v13: thêm cột task category, completeLink, phatSinh.
// v14: thêm cột task batchName (gom việc con cùng "đầu việc chung").
// v15: thêm sheet Chats + Messages (mục Tin nhắn / chat).
// v16: thêm cột task assigneeCodes (nhiều người thực hiện trong 1 task; tương thích ngược -> [assigneeCode]).
// v17: định dạng lại MỌI sheet cho gọn gàng (header, kẻ sọc, bề rộng cột, clip) qua formatSheets_().
// v18: thêm cột task startDate (ngày bắt đầu dự kiến) + needSupport/supportNote (yêu cầu hỗ trợ).
// v19: tạo tài khoản ADMIN (vai trò ROLE.ADMIN, quyền cao nhất).
// v20: ẨN ADMIN — chuyển credentials sang Script Property, XOÁ ADMIN khỏi sheet Members (không lưu pass/info ADMIN ở data storage).
var MIG_VERSION = '20';
function ensureMigrated_() {
  try {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('MIG_VERSION') === MIG_VERSION) return;
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(8000)) return; // có tiến trình khác đang chạy -> để lần sau
    try {
      if (props.getProperty('MIG_VERSION') === MIG_VERSION) return; // kiểm tra lại trong lock
      migrate_();
      props.setProperty('MIG_VERSION', MIG_VERSION);
    } finally { lock.releaseLock(); }
  } catch (e) { Logger.log('ensureMigrated_ lỗi: ' + e); } // không chặn app nếu migrate lỗi
}

function bootstrap() {
  // KHÔNG trả danh sách nhân sự ở màn hình đăng nhập (tránh lộ toàn bộ roster trước khi xác thực).
  // Đăng nhập bằng cách NHẬP mã + PIN (không chọn từ dropdown).
  ensureMigrated_(); // chạy migrate_ MỘT LẦN sau mỗi lần deploy (kể cả khi bảng đã tồn tại sẵn).
  return {
    departmentName: getConfigValue_('DepartmentName', 'Phòng Tổ chức Hành chính - Bệnh viện Nhi Đồng 2'),
    difficulties: difficultyList_(),
    statuses: STATUS_ORDER,
    members: []
  };
}

/**
 * Trạng thái sau khi đăng nhập. Manager thấy toàn bộ; chuyên viên chỉ thấy việc
 * và dự án của mình. Danh sách members trả về đủ để client hiển thị TÊN cho mọi
 * mã xuất hiện trong dữ liệu mà người dùng được phép thấy.
 */
function getState(token) {
  var u = requireUser_(token);
  var allTasks = readTasks_();
  var allProjects = readProjects_();
  var allMembers = readMembers_();

  var urank = rankOf_(u.role);
  var dScope = deptScopeOf_(u.role);   // all / allButHigher / own / none
  var crewAll = canManageCrew_(u);     // thấy & quản lý TOÀN BỘ crew
  var crewOwn = !crewAll && isCrewRole_(u.role); // crew non-manager: chỉ việc của mình

  var roleByCode = {};
  allMembers.forEach(function (m) { roleByCode[m.code] = m.role; });
  function aRank(t) { var r = roleByCode[t.assigneeCode]; return (r === undefined) ? 9 : rankOf_(r); }
  function aIsCrew(t) { return isCrewRole_(roleByCode[t.assigneeCode]); }

  // ----- TASKS = (việc Phòng theo dScope) + (việc Crew theo quyền crew) -----
  // Việc "Chưa đăng ký" (assigneeCode rỗng) hiển thị cho mọi người đủ điều kiện để có thể NHẬN.
  var deptTasks = [];
  if (dScope === 'all') deptTasks = allTasks.filter(function (t) { return !t.crewTask; });
  else if (dScope === 'allButHigher') deptTasks = allTasks.filter(function (t) { return !t.crewTask && (aRank(t) >= urank || isTaskAssignee_(t, u.code)); });
  else if (dScope === 'own') deptTasks = allTasks.filter(function (t) { return !t.crewTask && (isTaskAssignee_(t, u.code) || !t.assigneeCode); });
  var crewTasksArr = [];
  if (crewAll) crewTasksArr = allTasks.filter(function (t) { return t.crewTask && (aIsCrew(t) || !t.assigneeCode); });
  else if (crewOwn) crewTasksArr = allTasks.filter(function (t) { return t.crewTask && (isTaskAssignee_(t, u.code) || !t.assigneeCode); });
  var tasks = deptTasks.concat(crewTasksArr);

  // ----- PROJECTS — dự án dùng chung; crew cũng thấy để LIÊN KẾT task crew vào dự án Trung Tâm. -----
  var projects;
  if (dScope === 'all' || dScope === 'allButHigher') projects = allProjects;
  else if (dScope === 'own') projects = allProjects.filter(function (p) { return p.leadCode === u.code || (p.memberCodes || []).indexOf(u.code) >= 0; });
  else if (canViewCrew_(u)) projects = allProjects; // crew (Lead/Sub-Lead/Thành viên) thấy dự án để liên kết
  else projects = [];

  // ----- MEMBERS (chỉ những người viewer được phép thấy) -----
  var allow = {}; allow[u.code] = true;
  if (dScope === 'all') allMembers.forEach(function (m) { if (!isCrewRole_(m.role)) allow[m.code] = true; });
  else if (dScope === 'allButHigher') allMembers.forEach(function (m) { if (!isCrewRole_(m.role) && rankOf_(m.role) >= urank) allow[m.code] = true; });
  else if (dScope === 'own') {
    var ref = {};
    projects.forEach(function (p) { ref[p.leadCode] = 1; (p.memberCodes || []).forEach(function (c) { ref[c] = 1; }); });
    deptTasks.forEach(function (t) { taskAssignees_(t).forEach(function (c) { ref[c] = 1; }); });
    // Chuyên viên thấy TẤT CẢ chuyên viên cùng/​thấp cấp (peers) để GIAO việc cho nhau; vẫn KHÔNG thấy cấp cao hơn.
    allMembers.forEach(function (m) { if (!isCrewRole_(m.role) && rankOf_(m.role) >= urank) allow[m.code] = true; });
  }
  if (crewAll) allMembers.forEach(function (m) { if (isCrewRole_(m.role)) allow[m.code] = true; });
  var members = allMembers.filter(function (m) { return allow[m.code]; }).map(publicMember_);

  // KPI targets: CHỈ trả về mục tiêu của những người mà viewer được phép thấy (tránh lộ KPI cấp cao / silo khác).
  var allowed = {}; members.forEach(function (m) { allowed[m.code] = true; });
  var allKpi = readKpiTargets_(); var kpiTargets = {};
  Object.keys(allKpi).forEach(function (c) { if (allowed[c]) kpiTargets[c] = allKpi[c]; });

  // FIX "—": gắn TÊN người tạo vào TỪNG task để hiển thị/thông báo (kể cả khi người tạo bị ẩn khỏi danh sách theo cấp bậc).
  // KHÔNG đụng danh sách members -> giữ nguyên cách ly cấp bậc/silo.
  var _nameAll = {}; allMembers.forEach(function (m) { _nameAll[m.code] = m.name; });
  tasks.forEach(function (t) { t.createdByName = isAdminCode_(t.createdBy) ? '***' : (_nameAll[t.createdBy] || t.createdBy || ''); });

  return {
    user: u,
    tasks: tasks,
    projects: projects,
    members: members,
    config: {
      departmentName: getConfigValue_('DepartmentName', 'Phòng Tổ chức Hành chính - Bệnh viện Nhi Đồng 2'),
      difficulties: difficultyList_(),
      statuses: STATUS_ORDER
    },
    kpiTargets: kpiTargets
  };
}

// ---------------------------------------------------------------------------
// API: Công việc
// ---------------------------------------------------------------------------
/**
 * Tạo công việc — chỉ Trưởng/Phó phòng.
 * Mã = "<PREFIX>-<SEQ>-<MEMBERCODE>": PREFIX = yyyyMMdd (việc daily) hoặc
 * phần số của projectId (việc dự án). SEQ monotonic theo PREFIX, tính từ sheet.
 */
function createTask(token, payload) {
  payload = payload || {};
  var crewTask = !!payload.crewTask;
  var u = requireUser_(token);
  // NHIỀU người thực hiện trong 1 task: nhận payload.assigneeCodes (mảng) hoặc assigneeCode (1 người, tương thích cũ).
  var rawCodes = [];
  if (payload.assigneeCodes && payload.assigneeCodes.length) rawCodes = [].concat(payload.assigneeCodes);
  else if (payload.assigneeCode) rawCodes = [payload.assigneeCode];
  rawCodes = rawCodes.map(function (c) { return String(c || '').trim(); }).filter(Boolean);
  var _seen = {}; rawCodes = rawCodes.filter(function (c) { if (_seen[c]) return false; _seen[c] = 1; return true; }); // loại trùng, giữ thứ tự
  var unassigned = rawCodes.length === 0; // tạo "việc chưa giao" (Chưa đăng ký) — CHỈ quản lý mới được; người khác tự nhận sau.
  // Quyền tạo việc:
  //  - Task crew: cần quyền quản lý crew (Trưởng/Phó phòng + Lead/Sub-Lead + người được giao MANAGE_CREW).
  //  - Task daily/dự án: Trưởng/Phó phòng giao cho ai cũng được; CHUYÊN VIÊN được TỰ giao việc cho CHÍNH MÌNH.
  //    (Thành viên Production Crew KHÔNG có bảng Phòng nên không lọt vào nhánh này.)
  var selfCreate = false;
  function _selfOnly() { return rawCodes.length === 1 && rawCodes[0] === u.code; }
  if (crewTask) {
    if (!canManageCrew_(u)) {
      // Thành viên crew (không phải quản lý) được TỰ giao việc crew cho chính mình.
      if (!isCrewRole_(u.role)) throw err_('Bạn không có quyền quản lý Production Crew.');
      selfCreate = true;
      if (unassigned || !_selfOnly()) throw err_('Bạn chỉ được tự giao việc cho chính mình.');
    }
  } else if (!isManager_(u)) {
    if (deptScopeOf_(u.role) !== 'own') throw err_('Chỉ Trưởng phòng / Phó phòng mới có quyền thực hiện thao tác này.');
    selfCreate = true;
    // Chuyên viên được GIAO cho chuyên viên KHÁC (peers); KHÔNG được tạo việc "Chưa giao". Guard outranksWithinSilo_ vẫn chặn giao LÊN cấp cao.
    if (unassigned) throw err_('Chuyên viên phải chọn người thực hiện (không tạo việc "Chưa giao").');
  }
  // -> Tới đây: nếu unassigned thì người tạo CHẮC CHẮN là quản lý (Trưởng/Phó phòng, hoặc quản lý crew với task crew).

  var members = readMembers_();
  var assignees = []; // mảng member object đã xác thực
  if (!unassigned) {
    rawCodes.forEach(function (rc) {
      var a = members.filter(function (m) { return m.code === rc && m.active; })[0];
      if (!a) throw err_('Người được giao việc không hợp lệ: ' + rc);
      if (crewTask && !isCrewRole_(a.role)) throw err_('Chỉ giao task crew cho thành viên thuộc Production Crew.');
      if (!crewTask && !hasDeptBoard_(a.role)) throw err_('Việc của Phòng chỉ giao cho nhân sự có mặt ở Phòng.');
      // Quản lý crew toàn quyền (Trưởng/Phó phòng hoặc người ĐƯỢC CẤP QUYỀN) giao task crew cho BẤT KỲ thành viên crew, không vướng cấp bậc.
      if (!(crewTask && isCrewAdmin_(u)) && outranksWithinSilo_(u.role, a.role)) throw err_('Không thể giao việc cho người có vai trò cao hơn.');
      assignees.push(a);
    });
  }
  var assigneeCodesArr = assignees.map(function (a) { return a.code; });
  var primaryCode = assigneeCodesArr.length ? assigneeCodesArr[0] : '';

  var difficulty = String(payload.difficulty || '').trim();
  if (DIFFICULTY_ORDER.indexOf(difficulty) < 0) throw err_('Độ khó không hợp lệ.');
  var points = 0; // KPI đã bỏ — không còn chấm điểm

  var title = String(payload.title || '').trim();
  if (!title) throw err_('Vui lòng nhập tên công việc.');

  var deadline = normalizeDate_(payload.deadline);
  var projectId = String(payload.projectId || '').trim();
  if (projectId) {
    var prj = readProjects_().filter(function (p) { return p.id === projectId; })[0];
    if (!prj) throw err_('Dự án không tồn tại.');
    // Chuyên viên tự tạo việc trong dự án: phải là Lead hoặc thành viên của dự án đó.
    if (selfCreate && prj.leadCode !== u.code && (prj.memberCodes || []).indexOf(u.code) < 0) {
      throw err_('Bạn không thuộc dự án này.');
    }
    // Ràng buộc: hạn của việc con KHÔNG được trễ hơn ngày sự kiện (eventDate = ngày cuối của dự án).
    if (deadline && prj.eventDate && deadline > prj.eventDate) {
      throw err_('Hạn công việc không được trễ hơn ngày sự kiện của dự án (' + prj.eventDate + ').');
    }
  }

  var description = String(payload.description || '').trim();
  var note = String(payload.note || '').trim();

  var priority = String(payload.priority || '').trim();
  if (PRIORITY_ORDER.indexOf(priority) < 0) priority = 'Bình thường';

  var category = String(payload.category || '').trim();
  if (category && WORK_CATEGORIES.indexOf(category) < 0) category = '';
  var phatSinh = !!payload.phatSinh && !!projectId; // chỉ task trong dự án mới có "phát sinh"
  var batchName = String(payload.batchName || '').trim(); // "đầu việc chung" gom các việc con
  var startDate = normalizeDate_(payload.startDate); // NGÀY bắt đầu dự kiến (tùy chọn)
  if (startDate && deadline && startDate > deadline) throw err_('Ngày bắt đầu không được trễ hơn hạn cuối.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var prefix = projectId ? projectId.replace('PRJ-', '') : (crewTask ? 'CREW' : Utilities.formatDate(new Date(), TZ, 'yyyyMMdd'));
    var tSheet = getSheet_(SH_TASKS);
    var codes = tSheet.getDataRange().getValues();
    var maxSeq = 0;
    for (var i = 1; i < codes.length; i++) {
      var parts = String(codes[i][0]).split('-');
      // mã có thể là "yyyyMMdd-SEQ-CODE" hoặc "2026-001-SEQ-CODE" (PRJ-2026-001)
      var c0 = String(codes[i][0]);
      if (c0.indexOf(prefix + '-') === 0) {
        var rest = c0.substring(prefix.length + 1).split('-');
        var n = Number(rest[0]);
        if (!isNaN(n) && n > maxSeq) maxSeq = n;
      }
    }
    var seq = maxSeq + 1;
    var suffix = unassigned ? 'CHUA' : primaryCode; // việc chưa giao -> hậu tố CHUA; nhiều người -> hậu tố = người đầu tiên
    var code = prefix + '-' + ('00' + seq).slice(-3) + '-' + suffix;

    var task = {
      taskCode: code, title: title, description: description,
      assigneeCode: primaryCode, assigneeCodes: assigneeCodesArr, difficulty: difficulty, kpiPoint: points,
      status: unassigned ? STATUS.UNCLAIMED : STATUS.TODO, createdBy: u.code, createdAt: nowIso_(),
      deadline: deadline, startedAt: '', submittedAt: '', completedAt: '',
      reportLink: '', note: note, priority: priority,
      pauseHours: 0, lastPausedAt: '', projectId: projectId || '', crewTask: crewTask,
      category: category, completeLink: '', phatSinh: phatSinh, batchName: batchName,
      startDate: startDate, needSupport: false, supportNote: ''
    };
    tSheet.appendRow(taskToRow_(task));
    task.projectId = projectId || null;
    return task;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Chuyển trạng thái công việc.
 *  start:Chưa bắt đầu→Đang chạy | pause:Đang chạy→Tạm dừng |
 *  resume:Tạm dừng→Đang chạy | submit:Đang chạy→Đã gửi | complete:Đã gửi→Hoàn thành
 * Link báo cáo là TÙY CHỌN (khớp giao diện mới). Mọi kiểm tra ở SERVER.
 */
function transitionTask(token, taskCode, action, reportLink) {
  var u = requireUser_(token);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_TASKS);
    var values = sh.getDataRange().getValues();
    var rowIdx = -1, matches = 0;
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]) === String(taskCode)) { matches++; if (rowIdx < 0) rowIdx = i; }
    }
    if (rowIdx < 0) throw err_('Không tìm thấy công việc.');
    if (matches > 1) throw err_('Dữ liệu trùng mã công việc, vui lòng liên hệ quản trị.');

    var t = taskObjFromRow_(values[rowIdx]);
    var now = nowIso_();

    // NHẬN việc "Chưa đăng ký": người đủ điều kiện tự nhận -> trở thành người thực hiện.
    if (action === 'claim') {
      if (t.status !== STATUS.UNCLAIMED || t.assigneeCode) throw err_('Công việc này đã có người nhận.');
      var canClaim = t.crewTask ? (isCrewRole_(u.role) || canManageCrew_(u)) : hasDeptBoard_(u.role);
      if (!canClaim) throw err_('Bạn không thể nhận công việc này.');
      t.assigneeCode = u.code; t.assigneeCodes = [u.code]; t.status = STATUS.TODO;
      var rowC = taskToRow_(t);
      sh.getRange(rowIdx + 1, 1, 1, rowC.length).setValues([rowC]);
      t.projectId = t.projectId || null;
      return t;
    }

    // ÉP đổi trạng thái (Leader/Sub-Lead/Trưởng/Phó phòng) — bỏ qua máy trạng thái tuần tự.
    if (action === 'force') {
      var canForce = t.crewTask ? canManageCrew_(u) : isManager_(u);
      if (!canForce) throw err_('Chỉ quản lý mới được ép đổi trạng thái.');
      if (!t.assigneeCode) throw err_('Việc chưa có người nhận — không thể đổi trạng thái.');
      var ns = String(reportLink || '').trim(); // tham số thứ 4 mang TRẠNG THÁI MỚI
      if (STATUS_ORDER.indexOf(ns) < 0) throw err_('Trạng thái không hợp lệ.');
      t.status = ns;
      if (ns === STATUS.RUNNING && !t.startedAt) t.startedAt = now;
      if (ns === STATUS.SENT && !t.submittedAt) t.submittedAt = now;
      if (ns === STATUS.DONE && !t.completedAt) t.completedAt = now;
      var rowF = taskToRow_(t);
      sh.getRange(rowIdx + 1, 1, 1, rowF.length).setValues([rowF]);
      t.projectId = t.projectId || null;
      return t;
    }

    // CHỈ người được giao việc mới thao tác được (bất kỳ AI trong danh sách người thực hiện); manager/khác KHÔNG có quyền.
    if (!isTaskAssignee_(t, u.code)) throw err_('Chỉ người được giao việc mới có quyền thao tác trên công việc này.');

    if (action === 'start') {
      if (t.status !== STATUS.TODO) throw err_('Chỉ bắt đầu được công việc "Chưa bắt đầu".');
      t.status = STATUS.RUNNING; t.startedAt = now;
    } else if (action === 'pause') {
      if (t.status !== STATUS.RUNNING) throw err_('Chỉ tạm hoãn được công việc "Đang chạy".');
      t.status = STATUS.PENDING; t.lastPausedAt = now;
    } else if (action === 'resume') {
      if (t.status !== STATUS.PENDING) throw err_('Chỉ tiếp tục được công việc "Tạm dừng".');
      t.status = STATUS.RUNNING;
      if (t.lastPausedAt) {
        var dp = Date.parse(t.lastPausedAt);
        if (!isNaN(dp)) t.pauseHours = (t.pauseHours || 0) + Math.max(0, (Date.parse(now) - dp) / 3600000);
        t.lastPausedAt = '';
      }
    } else if (action === 'submit') {
      if (t.status !== STATUS.RUNNING) throw err_('Chỉ gửi báo cáo khi công việc "Đang chạy".');
      t.status = STATUS.SENT; t.submittedAt = now;
      t.reportLink = String(reportLink || '').trim();
    } else if (action === 'complete') {
      if (t.status !== STATUS.SENT) throw err_('Chỉ xác nhận hoàn thành khi công việc "Đã gửi".');
      t.status = STATUS.DONE; t.completedAt = now;
      if (reportLink !== undefined && reportLink !== null && String(reportLink).trim() !== '') t.completeLink = String(reportLink).trim();
    } else {
      throw err_('Hành động không hợp lệ.');
    }

    var newRow = taskToRow_(t);
    sh.getRange(rowIdx + 1, 1, 1, newRow.length).setValues([newRow]);
    t.projectId = t.projectId || null;
    return t;
  } finally {
    lock.releaseLock();
  }
}

/** Cập nhật ghi chú của công việc (assignee hoặc manager). */
function updateTaskNote(token, taskCode, note) {
  var u = requireUser_(token);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_TASKS);
    var values = sh.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]) === String(taskCode)) { rowIdx = i; break; }
    }
    if (rowIdx < 0) throw err_('Không tìm thấy công việc.');
    var t = taskObjFromRow_(values[rowIdx]);
    if (!isTaskAssignee_(t, u.code)) throw err_('Chỉ người được giao việc mới có quyền sửa ghi chú công việc này.');
    t.note = String(note || '');
    var newRow = taskToRow_(t);
    sh.getRange(rowIdx + 1, 1, 1, newRow.length).setValues([newRow]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/** Đặt/đổi HẠN của task bằng KÉO-THẢ trên lịch (tự điền ngày, không cần mở form sửa). */
function setTaskDeadline(token, taskCode, deadline) {
  var u = requireUser_(token);
  var dl = normalizeDate_(deadline);
  if (!dl) throw err_('Ngày không hợp lệ.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_TASKS);
    var values = sh.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < values.length; i++) { if (String(values[i][0]) === String(taskCode)) { rowIdx = i; break; } }
    if (rowIdx < 0) throw err_('Không tìm thấy công việc.');
    var t = taskObjFromRow_(values[rowIdx]);
    if (!canEditTask_(u, t) && !isTaskAssignee_(t, u.code)) throw err_('Bạn không có quyền đổi hạn công việc này.');
    if (t.projectId) {
      var prj = readProjects_().filter(function (p) { return p.id === t.projectId; })[0];
      if (prj && prj.eventDate && dl > prj.eventDate) throw err_('Hạn không được trễ hơn ngày sự kiện của dự án (' + prj.eventDate + ').');
    }
    t.deadline = dl;
    var newRow = taskToRow_(t);
    sh.getRange(rowIdx + 1, 1, 1, newRow.length).setValues([newRow]);
    t.projectId = t.projectId || null;
    return t;
  } finally { lock.releaseLock(); }
}

/** Người THỰC HIỆN bật/tắt cờ "Cần hỗ trợ" trên công việc của mình (kèm lý do tùy chọn). Quản lý sẽ thấy badge. */
function setTaskSupport(token, taskCode, need, note) {
  var u = requireUser_(token);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_TASKS);
    var values = sh.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < values.length; i++) { if (String(values[i][0]) === String(taskCode)) { rowIdx = i; break; } }
    if (rowIdx < 0) throw err_('Không tìm thấy công việc.');
    var t = taskObjFromRow_(values[rowIdx]);
    if (!isTaskAssignee_(t, u.code)) throw err_('Chỉ người thực hiện mới được yêu cầu hỗ trợ cho công việc này.');
    t.needSupport = !!need;
    t.supportNote = need ? String(note || '').trim() : '';
    var newRow = taskToRow_(t);
    sh.getRange(rowIdx + 1, 1, 1, newRow.length).setValues([newRow]);
    t.projectId = t.projectId || null;
    return t;
  } finally { lock.releaseLock(); }
}

/** Sửa thông tin task (title/desc/assignee/difficulty/priority/deadline/note). Giữ nguyên trạng thái & timestamps. */
function updateTask(token, taskCode, payload) {
  var u = requireUser_(token);
  payload = payload || {};
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_TASKS);
    var values = sh.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < values.length; i++) { if (String(values[i][0]) === String(taskCode)) { rowIdx = i; break; } }
    if (rowIdx < 0) throw err_('Không tìm thấy công việc.');
    var t = taskObjFromRow_(values[rowIdx]);
    if (!canEditTask_(u, t)) throw err_('Bạn không có quyền sửa công việc này.');
    // Người sửa vì là CHÍNH CHỦ (không phải quản lý) thì không được giao lại cho người khác.
    // NHIỀU người thực hiện: payload.assigneeCodes (mảng) hoặc assigneeCode (1 người, tương thích cũ).
    var upCodes = [];
    if (payload.assigneeCodes && payload.assigneeCodes.length) upCodes = [].concat(payload.assigneeCodes);
    else if (payload.assigneeCode !== undefined) upCodes = [payload.assigneeCode];
    upCodes = upCodes.map(function (c) { return String(c || '').trim(); }).filter(Boolean);
    var _su = {}; upCodes = upCodes.filter(function (c) { if (_su[c]) return false; _su[c] = 1; return true; });
    if (!upCodes.length) throw err_('Người được giao việc không hợp lệ.');
    // Người sửa vì là CHÍNH CHỦ (không phải quản lý) thì không được giao lại cho người khác (chỉ giữ chính mình).
    if (!canManageTask_(u, t) && !(upCodes.length === 1 && upCodes[0] === u.code)) throw err_('Bạn chỉ được sửa việc của chính mình.');

    var title = String(payload.title || '').trim();
    if (!title) throw err_('Vui lòng nhập tên công việc.');
    var upMembers = readMembers_();
    var upAssignees = [];
    upCodes.forEach(function (rc) {
      var a = upMembers.filter(function (m) { return m.code === rc && m.active; })[0];
      if (!a) throw err_('Người được giao việc không hợp lệ: ' + rc);
      if (t.crewTask && !isCrewRole_(a.role)) throw err_('Chỉ giao task crew cho thành viên thuộc Production Crew.');
      if (!t.crewTask && !hasDeptBoard_(a.role)) throw err_('Việc của Phòng chỉ giao cho nhân sự có mặt ở Phòng.');
      if (!(t.crewTask && isCrewAdmin_(u)) && outranksWithinSilo_(u.role, a.role)) throw err_('Không thể giao việc cho người có vai trò cao hơn.');
      upAssignees.push(a);
    });
    var difficulty = String(payload.difficulty || '').trim();
    if (DIFFICULTY_ORDER.indexOf(difficulty) < 0) throw err_('Độ khó không hợp lệ.');
    var points = 0; // KPI đã bỏ
    var priority = String(payload.priority || '').trim();
    if (PRIORITY_ORDER.indexOf(priority) < 0) priority = 'Bình thường';

    t.title = title;
    t.description = String(payload.description || '').trim();
    t.assigneeCode = upAssignees[0].code;
    t.assigneeCodes = upAssignees.map(function (a) { return a.code; });
    t.difficulty = difficulty;
    t.kpiPoint = points;
    t.priority = priority;
    t.deadline = normalizeDate_(payload.deadline);
    // Ràng buộc: hạn việc con KHÔNG được trễ hơn ngày sự kiện của dự án (eventDate = ngày cuối).
    if (t.projectId) {
      var prjU = readProjects_().filter(function (p) { return p.id === t.projectId; })[0];
      if (prjU && t.deadline && prjU.eventDate && t.deadline > prjU.eventDate) {
        throw err_('Hạn công việc không được trễ hơn ngày sự kiện của dự án (' + prjU.eventDate + ').');
      }
    }
    if (payload.note !== undefined) t.note = String(payload.note || '');
    if (payload.category !== undefined) {
      var cat = String(payload.category || '').trim();
      t.category = (cat && WORK_CATEGORIES.indexOf(cat) >= 0) ? cat : '';
    }
    if (payload.phatSinh !== undefined) t.phatSinh = !!payload.phatSinh && !!t.projectId;
    if (payload.startDate !== undefined) {
      t.startDate = normalizeDate_(payload.startDate);
      if (t.startDate && t.deadline && t.startDate > t.deadline) throw err_('Ngày bắt đầu không được trễ hơn hạn cuối.');
    }

    var newRow = taskToRow_(t);
    sh.getRange(rowIdx + 1, 1, 1, newRow.length).setValues([newRow]);
    t.projectId = t.projectId || null;
    return t;
  } finally {
    lock.releaseLock();
  }
}

/** Xoá hẳn một task. Quyền: task crew -> quản lý crew; còn lại -> Trưởng/Phó phòng. */
function deleteTask(token, taskCode) {
  var u = requireUser_(token);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_TASKS);
    var values = sh.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < values.length; i++) { if (String(values[i][0]) === String(taskCode)) { rowIdx = i; break; } }
    if (rowIdx < 0) throw err_('Không tìm thấy công việc.');
    var t = taskObjFromRow_(values[rowIdx]);
    // Quản lý xoá được mọi việc trong phạm vi; CHUYÊN VIÊN/thành viên crew được xoá việc CỦA CHÍNH MÌNH.
    var ownDelete = isTaskAssignee_(t, u.code) && (deptScopeOf_(u.role) === 'own' || isCrewRole_(u.role));
    if (!canManageTask_(u, t) && !ownDelete) throw err_('Bạn không có quyền xoá công việc này.');
    sh.deleteRow(rowIdx + 1);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// API: Dự án
// ---------------------------------------------------------------------------
function createProject(token, payload) {
  var u = requireManager_(token);
  payload = payload || {};
  var name = String(payload.name || '').trim();
  if (!name) throw err_('Vui lòng nhập tên dự án.');
  var leadCode = String(payload.leadCode || '').trim();
  if (!leadCode) throw err_('Vui lòng chọn Lead dự án.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_PROJECTS);
    var existing = readProjects_();
    var year = Utilities.formatDate(new Date(), TZ, 'yyyy');
    var maxSeq = 0;
    existing.forEach(function (p) {
      var m = /^PRJ-\d{4}-(\d+)$/.exec(p.id);
      if (m) { var n = Number(m[1]); if (n > maxSeq) maxSeq = n; }
    });
    var id = 'PRJ-' + year + '-' + ('00' + (maxSeq + 1)).slice(-3);
    var prj = {
      id: id, name: name, leadCode: leadCode,
      memberCodes: Array.isArray(payload.memberCodes) ? payload.memberCodes : [],
      eventDate: normalizeDate_(payload.eventDate), status: PROJ_STATUS.ACTIVE, createdAt: nowIso_()
    };
    sh.appendRow(projToRow_(prj));
    return prj;
  } finally {
    lock.releaseLock();
  }
}

function updateProject(token, payload) {
  var u = requireManager_(token);
  payload = payload || {};
  var id = String(payload.id || '').trim();
  if (!id) throw err_('Thiếu mã dự án.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_PROJECTS);
    var values = sh.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]).trim() === id) { rowIdx = i; break; }
    }
    if (rowIdx < 0) throw err_('Không tìm thấy dự án.');
    var p = projObjFromRow_(values[rowIdx]);
    p.name = String(payload.name || p.name).trim();
    p.leadCode = String(payload.leadCode || p.leadCode).trim();
    p.memberCodes = Array.isArray(payload.memberCodes) ? payload.memberCodes : p.memberCodes;
    p.eventDate = normalizeDate_(payload.eventDate);
    var newRow = projToRow_(p);
    sh.getRange(rowIdx + 1, 1, 1, newRow.length).setValues([newRow]);
    return p;
  } finally {
    lock.releaseLock();
  }
}

function completeProject(token, id) {
  var u = requireManager_(token);
  id = String(id || '').trim();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_PROJECTS);
    var values = sh.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]).trim() === id) { rowIdx = i; break; }
    }
    if (rowIdx < 0) throw err_('Không tìm thấy dự án.');
    var p = projObjFromRow_(values[rowIdx]);
    p.status = PROJ_STATUS.COMPLETED;
    var newRow = projToRow_(p);
    sh.getRange(rowIdx + 1, 1, 1, newRow.length).setValues([newRow]);
    return p;
  } finally {
    lock.releaseLock();
  }
}

/** Xoá dự án + XOÁ LUÔN mọi task thuộc dự án đó (cascade). Chỉ Trưởng/Phó phòng. */
function deleteProject(token, id) {
  var u = requireManager_(token);
  id = String(id || '').trim();
  if (!id) throw err_('Thiếu mã dự án.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var psh = getSheet_(SH_PROJECTS);
    var pv = psh.getDataRange().getValues();
    var prowIdx = -1;
    for (var i = 1; i < pv.length; i++) { if (String(pv[i][0]).trim() === id) { prowIdx = i; break; } }
    if (prowIdx < 0) throw err_('Không tìm thấy dự án.');
    psh.deleteRow(prowIdx + 1);

    // cascade: xoá các task có projectId === id (xoá từ dưới lên để không lệch chỉ số)
    var tsh = getSheet_(SH_TASKS);
    var tv = tsh.getDataRange().getValues();
    var pidCol = TASK_COLS.indexOf('projectId'); // 0-based
    var rowsToDelete = [];
    for (var j = 1; j < tv.length; j++) { if (String(tv[j][pidCol]).trim() === id) rowsToDelete.push(j + 1); }
    rowsToDelete.sort(function (a, b) { return b - a; }).forEach(function (r) { tsh.deleteRow(r); });
    return { ok: true, deletedTasks: rowsToDelete.length };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// API: Nhân sự — Trưởng phòng / Phó phòng
// ---------------------------------------------------------------------------
// Mã thành viên có trùng không (so sánh không phân biệt hoa thường, loại trừ exceptCode = dòng đang sửa).
function memberCodeExists_(values, code, exceptCode) {
  code = String(code).trim().toUpperCase();
  exceptCode = String(exceptCode || '').trim().toUpperCase();
  for (var i = 1; i < values.length; i++) {
    var c = String(values[i][0]).trim().toUpperCase();
    if (c && c === code && c !== exceptCode) return true;
  }
  return false;
}

// Đổi MÃ thành viên: cập nhật mọi tham chiếu (task assignee/creator, project lead/members, KPI key).
// KHÔNG đổi taskCode (mã lịch sử, dùng làm khoá hàng + đếm seq).
function cascadeMemberCode_(oldCode, newCode) {
  oldCode = String(oldCode).trim().toUpperCase();
  newCode = String(newCode).trim();
  var tSheet = getSheet_(SH_TASKS), tv = tSheet.getDataRange().getValues();
  var acIdx = TASK_COLS.indexOf('assigneeCodes');
  for (var i = 1; i < tv.length; i++) {
    if (String(tv[i][3]).trim().toUpperCase() === oldCode) tSheet.getRange(i + 1, 4).setValue(newCode);   // assigneeCode
    if (String(tv[i][7]).trim().toUpperCase() === oldCode) tSheet.getRange(i + 1, 8).setValue(newCode);   // createdBy
    if (acIdx >= 0 && tv[i].length > acIdx && tv[i][acIdx]) {                                              // assigneeCodes (mảng nhiều người)
      var arr2; try { arr2 = JSON.parse(tv[i][acIdx]); } catch (e) { arr2 = null; }
      if (arr2 instanceof Array) {
        var chg = false;
        for (var z = 0; z < arr2.length; z++) { if (String(arr2[z]).trim().toUpperCase() === oldCode) { arr2[z] = newCode; chg = true; } }
        if (chg) tSheet.getRange(i + 1, acIdx + 1).setValue(JSON.stringify(arr2));
      }
    }
  }
  var pSheet = getSheet_(SH_PROJECTS), pv = pSheet.getDataRange().getValues();
  for (var j = 1; j < pv.length; j++) {
    if (String(pv[j][2]).trim().toUpperCase() === oldCode) pSheet.getRange(j + 1, 3).setValue(newCode);   // leadCode
    var arr = projObjFromRow_(pv[j]).memberCodes, changed = false;
    for (var k = 0; k < arr.length; k++) { if (String(arr[k]).trim().toUpperCase() === oldCode) { arr[k] = newCode; changed = true; } }
    if (changed) pSheet.getRange(j + 1, 4).setValue(JSON.stringify(arr));
  }
  var kSheet = getSheet_(SH_KPI), kv = kSheet.getDataRange().getValues();
  for (var m = 1; m < kv.length; m++) {
    if (String(kv[m][0]).trim().toUpperCase() === oldCode) kSheet.getRange(m + 1, 1).setValue(newCode);   // KPI key
  }
}

function upsertMember(token, payload) {
  var u = requireManager_(token); // Trưởng phòng + Phó phòng
  payload = payload || {};

  var code = String(payload.code || '').trim().toUpperCase();
  var origCode = String(payload.origCode || '').trim().toUpperCase();
  var name = String(payload.name || '').trim();
  var role = String(payload.role || '').trim();
  var title = String(payload.title || '').trim();
  var active = payload.active === undefined ? true : !!payload.active;

  if (!code) throw err_('Vui lòng nhập mã thành viên.');
  if (!name) throw err_('Vui lòng nhập họ tên.');
  if (ALL_ROLES.indexOf(role) < 0) throw err_('Vai trò không hợp lệ.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_MEMBERS);
    var values = sh.getDataRange().getValues();
    var lookup = origCode || code; // sửa: tìm theo mã CŨ; tạo: theo mã mới
    var rowIdx = -1;
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]).trim().toUpperCase() === lookup) { rowIdx = i; break; }
    }
    if (origCode && rowIdx < 0) throw err_('Không tìm thấy thành viên cần sửa.');
    if (!origCode && rowIdx >= 0) throw err_('Mã thành viên đã tồn tại.');
    // Mã (mới) KHÔNG được trùng người khác — áp dụng cho cả TẠO và SỬA.
    if (memberCodeExists_(values, code, origCode)) throw err_('Mã thành viên đã tồn tại.');

    if (rowIdx < 0) {
      var pin = String(payload.pin || '').trim();
      if (pin.length < 4) throw err_('Mã cá nhân (PIN) tối thiểu 4 ký tự.');
      sh.appendRow([code, name, hashPin_(pin), role, title, active, nowIso_(), '[]', '']);
    } else {
      var cur = values[rowIdx];
      if (String(cur[3]).trim() === ROLE.ADMIN) throw err_('Không thể chỉnh sửa tài khoản ADMIN tại đây (đổi PIN trong mục Cài đặt).');
      var pinHash = String(cur[2]);
      if (payload.pin !== undefined && String(payload.pin).trim() !== '') {
        if (String(payload.pin).trim().length < 4) throw err_('Mã cá nhân (PIN) tối thiểu 4 ký tự.');
        pinHash = hashPin_(String(payload.pin).trim());
      }
      var updated = [code, name, pinHash, role, title, active, String(cur[6] || nowIso_()),
                     (cur[7] === undefined || cur[7] === '') ? '[]' : cur[7], (cur[8] === undefined ? '' : cur[8])]; // giữ avatar (cột 9)
      sh.getRange(rowIdx + 1, 1, 1, updated.length).setValues([updated]);
      // Đổi MÃ -> cascade mọi tham chiếu + sửa phiên của chính người gọi nếu họ tự đổi mã.
      if (origCode && code !== origCode) {
        cascadeMemberCode_(origCode, code);
        if (origCode === String(u.code).toUpperCase()) {
          CacheService.getScriptCache().put('S_' + token, code, SESSION_TTL);
        }
      }
    }
    return { ok: true, code: code, member: { code: code, name: name, role: role, title: title, active: active } };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// API: Vai trò Production Crew — Trưởng/Phó phòng + Lead/Sub-Lead
// Gán/gỡ thành viên vào crew bằng cách đổi role sang vai trò crew (hoặc về Chuyên viên).
// ---------------------------------------------------------------------------
function setCrewRole(token, memberCode, crewRole) {
  var u = requireCrewManager_(token);
  var code = String(memberCode || '').trim().toUpperCase();
  if (!code) throw err_('Thiếu mã thành viên.');
  var newRole = String(crewRole || '').trim();
  if (newRole && CREW_ROLES.indexOf(newRole) < 0) throw err_('Vai trò Production Crew không hợp lệ.');
  if (!newRole) newRole = ROLE.STAFF; // rỗng = gỡ khỏi crew

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_MEMBERS);
    var values = sh.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]).trim().toUpperCase() === code) { rowIdx = i; break; }
    }
    if (rowIdx < 0) throw err_('Không tìm thấy thành viên.');
    var curRole = String(values[rowIdx][3]).trim();
    if (curRole === ROLE.HEAD || curRole === ROLE.DEPUTY) throw err_('Không thể đổi vai trò của Trưởng/Phó phòng tại đây.');
    if (!isManager_(u) && !isCrewRole_(curRole)) throw err_('Chỉ Trưởng/Phó phòng mới được đưa người của Phòng vào Production Crew.');
    if (!isCrewAdmin_(u) && rankOf_(curRole) <= rankOf_(u.role)) throw err_('Chỉ được đổi vai trò thành viên crew có cấp thấp hơn bạn.');
    sh.getRange(rowIdx + 1, 4).setValue(newRole); // cột 'role' (cột thứ 4)
    return { ok: true, code: code, role: newRole };
  } finally {
    lock.releaseLock();
  }
}

/** Xoá hẳn 1 nhân sự. Phòng (Phó/Chuyên viên) -> Trưởng phòng; Crew -> quản lý crew + cấp thấp hơn.
 *  KHÔNG xoá chính mình & KHÔNG xoá Trưởng phòng (đổi vai trò trước). Task cũ giữ nguyên (hiện "—"). */
function deleteMember(token, code) {
  var u = requireUser_(token);
  code = String(code || '').trim().toUpperCase();
  if (!code) throw err_('Thiếu mã thành viên.');
  if (code === String(u.code).toUpperCase()) throw err_('Không thể tự xoá tài khoản của mình.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_MEMBERS);
    var values = sh.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < values.length; i++) { if (String(values[i][0]).trim().toUpperCase() === code) { rowIdx = i; break; } }
    if (rowIdx < 0) throw err_('Không tìm thấy thành viên.');
    var targetRole = String(values[rowIdx][3]).trim();
    if (targetRole === ROLE.ADMIN) throw err_('Không thể xoá tài khoản ADMIN.');
    if (targetRole === ROLE.HEAD) throw err_('Không thể xoá Trưởng phòng. Hãy đổi vai trò trước.');
    var allowed = isCrewRole_(targetRole)
      ? (canManageCrew_(u) && (isCrewAdmin_(u) || rankOf_(targetRole) > rankOf_(u.role)))
      : isHead_(u);
    if (!allowed) throw err_('Bạn không có quyền xoá nhân sự này.');
    sh.deleteRow(rowIdx + 1);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/** Thêm MỚI một thành viên Production Crew (quản lý crew). Vai trò bắt buộc là vai trò crew. */
function addCrewMember(token, payload) {
  var u = requireCrewManager_(token);
  payload = payload || {};
  var code = String(payload.code || '').trim().toUpperCase();
  var name = String(payload.name || '').trim();
  var role = String(payload.role || '').trim();
  var title = String(payload.title || '').trim();
  var pin = String(payload.pin || '').trim();
  if (!code) throw err_('Vui lòng nhập mã thành viên.');
  if (!name) throw err_('Vui lòng nhập họ tên.');
  if (CREW_ROLES.indexOf(role) < 0) throw err_('Vai trò Production Crew không hợp lệ.');
  if (!isCrewAdmin_(u) && rankOf_(role) < rankOf_(u.role)) throw err_('Không thể tạo vai trò cao hơn bạn.');
  if (pin.length < 4) throw err_('Mã PIN tối thiểu 4 ký tự.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_MEMBERS);
    var values = sh.getDataRange().getValues();
    if (memberCodeExists_(values, code, '')) throw err_('Mã thành viên đã tồn tại.');
    sh.appendRow([code, name, hashPin_(pin), role, title, true, nowIso_(), '[]', '']);
    return { ok: true, code: code };
  } finally {
    lock.releaseLock();
  }
}

/** Sửa ĐẦY ĐỦ thông tin một thành viên Production Crew (quản lý crew). Có thể đổi mã (cascade), tên, chức danh, vai trò crew, PIN.
 *  Chỉ sửa được người thuộc crew; quản lý không phải admin chỉ sửa được cấp thấp hơn mình. */
function updateCrewMember(token, payload) {
  var u = requireCrewManager_(token);
  payload = payload || {};
  var origCode = String(payload.origCode || '').trim().toUpperCase();
  var code = String(payload.code || '').trim().toUpperCase();
  var name = String(payload.name || '').trim();
  var role = String(payload.role || '').trim();
  var title = String(payload.title || '').trim();
  if (!origCode) throw err_('Thiếu mã thành viên cần sửa.');
  if (!code) throw err_('Vui lòng nhập mã thành viên.');
  if (!name) throw err_('Vui lòng nhập họ tên.');
  if (CREW_ROLES.indexOf(role) < 0) throw err_('Vai trò Production Crew không hợp lệ.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_MEMBERS);
    var values = sh.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < values.length; i++) { if (String(values[i][0]).trim().toUpperCase() === origCode) { rowIdx = i; break; } }
    if (rowIdx < 0) throw err_('Không tìm thấy thành viên.');
    var cur = values[rowIdx];
    var curRole = String(cur[3]).trim();
    if (!isCrewRole_(curRole)) throw err_('Chỉ sửa được thành viên thuộc Production Crew tại đây.');
    if (!isCrewAdmin_(u) && rankOf_(curRole) <= rankOf_(u.role)) throw err_('Chỉ được sửa thành viên crew có cấp thấp hơn bạn.');
    if (!isCrewAdmin_(u) && rankOf_(role) < rankOf_(u.role)) throw err_('Không thể nâng lên vai trò cao hơn bạn.');
    if (memberCodeExists_(values, code, origCode)) throw err_('Mã thành viên đã tồn tại.');

    var pinHash = String(cur[2]);
    if (payload.pin !== undefined && String(payload.pin).trim() !== '') {
      if (String(payload.pin).trim().length < 4) throw err_('Mã PIN tối thiểu 4 ký tự.');
      pinHash = hashPin_(String(payload.pin).trim());
    }
    var active = (payload.active === undefined) ? (cur[5] === true || String(cur[5]).toUpperCase() === 'TRUE') : !!payload.active;
    var updated = [code, name, pinHash, role, title, active, String(cur[6] || nowIso_()),
                   (cur[7] === undefined || cur[7] === '') ? '[]' : cur[7], (cur[8] === undefined ? '' : cur[8])]; // giữ grants + avatar
    sh.getRange(rowIdx + 1, 1, 1, updated.length).setValues([updated]);
    if (code !== origCode) {
      cascadeMemberCode_(origCode, code);
      if (origCode === String(u.code).toUpperCase()) CacheService.getScriptCache().put('S_' + token, code, SESSION_TTL);
    }
    return { ok: true, code: code };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// API: Phân quyền — Trưởng/Phó phòng GIAO quyền (vd: quản lý Production Crew) cho thành viên.
// ---------------------------------------------------------------------------
function setGrant(token, code, key, value) {
  requireManager_(token);
  code = String(code || '').trim().toUpperCase();
  if (GRANT_KEYS.indexOf(key) < 0) throw err_('Quyền không hợp lệ.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_MEMBERS);
    var values = sh.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < values.length; i++) { if (String(values[i][0]).trim().toUpperCase() === code) { rowIdx = i; break; } }
    if (rowIdx < 0) throw err_('Không tìm thấy thành viên.');
    var grants = parseGrants_(values[rowIdx][7]);
    var idx = grants.indexOf(key);
    if (value && idx < 0) grants.push(key);
    else if (!value && idx >= 0) grants.splice(idx, 1);
    sh.getRange(rowIdx + 1, MEMBER_COLS.indexOf('grants') + 1).setValue(JSON.stringify(grants));
    return { ok: true, code: code, grants: grants };
  } finally {
    lock.releaseLock();
  }
}

// API: Lưu ảnh đại diện — chỉ cho CHÍNH MÌNH (data URL ảnh đã nén ở client). Chuỗi rỗng = xoá ảnh.
function saveAvatar(token, dataUrl) {
  var u = requireUser_(token);
  dataUrl = String(dataUrl == null ? '' : dataUrl);
  if (dataUrl && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(dataUrl)) throw err_('Ảnh không hợp lệ.');
  if (dataUrl.length > 200000) throw err_('Ảnh quá lớn (tối đa ~150KB sau nén). Vui lòng chọn ảnh nhỏ hơn.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_MEMBERS);
    var values = sh.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < values.length; i++) { if (String(values[i][0]).trim().toUpperCase() === u.code) { rowIdx = i; break; } }
    if (rowIdx < 0) throw err_('Không tìm thấy thành viên.');
    sh.getRange(rowIdx + 1, MEMBER_COLS.indexOf('avatar') + 1).setValue(dataUrl);
    return { ok: true, code: u.code, avatar: dataUrl };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// API: Mục tiêu KPI — chỉ Trưởng phòng
// ---------------------------------------------------------------------------
function setKpiTarget(token, targets) {
  var u = requireHead_(token);
  targets = targets || {};
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_KPI);
    var values = sh.getDataRange().getValues();
    var idx = {};
    for (var i = 1; i < values.length; i++) {
      var c = String(values[i][0] || '').trim();
      if (c) idx[c] = i; // 0-based vào values
    }
    Object.keys(targets).forEach(function (code) {
      var val = parseFloat(targets[code]); if (isNaN(val)) val = 0;
      if (idx[code] !== undefined) {
        sh.getRange(idx[code] + 1, 2).setValue(val);
      } else {
        sh.appendRow([code, val]);
      }
    });
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// API: Đổi mã PIN — người dùng hiện tại
// ---------------------------------------------------------------------------
function changePassword(token, oldPin, newPin) {
  var u = requireUser_(token);
  if (String(newPin || '').trim().length < 4) throw err_('Mã PIN mới tối thiểu 4 ký tự.');
  // ADMIN: PIN lưu ở Script Property (không trong sheet) -> cập nhật tại đó.
  if (isAdminCode_(u.code)) {
    if (adminPinHash_() !== hashPin_(oldPin)) throw err_('Mã cá nhân hiện tại không đúng.');
    try { PropertiesService.getScriptProperties().setProperty('ADMIN_PINHASH', hashPin_(String(newPin).trim())); } catch (e) { throw err_('Không lưu được PIN ADMIN.'); }
    return { ok: true };
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_MEMBERS);
    var values = sh.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]).trim() === u.code) { rowIdx = i; break; }
    }
    if (rowIdx < 0) throw err_('Không tìm thấy tài khoản.');
    if (String(values[rowIdx][2]) !== hashPin_(oldPin)) throw err_('Mã cá nhân hiện tại không đúng.');
    sh.getRange(rowIdx + 1, 3).setValue(hashPin_(String(newPin).trim()));
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ===========================================================================
// API: TIN NHẮN / CHAT (Chats + Messages) — bảo mật theo thành viên hội thoại.
// ===========================================================================
function chatObjFromRow_(row) {
  var members = [];
  try { var raw = String(row[3] || '').trim(); if (raw) members = raw.charAt(0) === '[' ? JSON.parse(raw) : raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean); } catch (e) { members = []; }
  return { id: String(row[0] || '').trim(), type: String(row[1] || '').trim() || 'group', name: String(row[2] || ''), memberCodes: members, createdBy: String(row[4] || '').trim(), createdAt: cellToDateStr_(row[5], true) };
}
function chatToRow_(c) { return [c.id, c.type, c.name || '', JSON.stringify(c.memberCodes || []), c.createdBy || '', c.createdAt || nowIso_()]; }
function readChats_() {
  var sh = getSheet_(SH_CHATS); var v = sh.getDataRange().getValues(); var out = [];
  for (var i = 1; i < v.length; i++) { if (String(v[i][0]).trim()) out.push(chatObjFromRow_(v[i])); }
  return out;
}
function msgObjFromRow_(row) {
  return { id: Number(row[0]) || 0, chatId: String(row[1] || '').trim(), senderCode: String(row[2] || '').trim(), kind: String(row[3] || 'text'), body: String(row[4] == null ? '' : row[4]), createdAt: cellToDateStr_(row[5], true) };
}
function readMessages_() {
  var sh = getSheet_(SH_MESSAGES); var v = sh.getDataRange().getValues(); var out = [];
  for (var i = 1; i < v.length; i++) { if (String(v[i][0]).trim()) out.push(msgObjFromRow_(v[i])); }
  return out;
}
function isChatMember_(chat, code) { return chat && (chat.memberCodes || []).indexOf(code) >= 0; }
function findChat_(chats, id) { for (var i = 0; i < chats.length; i++) if (chats[i].id === id) return chats[i]; return null; }
function writeChat_(chat) {
  var sh = getSheet_(SH_CHATS); var v = sh.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) { if (String(v[i][0]).trim() === chat.id) { var r = chatToRow_(chat); sh.getRange(i + 1, 1, 1, r.length).setValues([r]); return; } }
  sh.appendRow(chatToRow_(chat));
}

/** Đảm bảo nhóm chat MẶC ĐỊNH của phòng/bộ phận tồn tại & có user. (createdBy='SYSTEM' = không xoá/sửa được) */
function ensureDefaultGroups_(u) {
  var chats = readChats_(), members = readMembers_(), changed = false;
  function ensure(id, name, inSilo) {
    var c = findChat_(chats, id);
    if (!c) {
      c = { id: id, type: 'group', name: name, memberCodes: members.filter(function (m) { return m.active && inSilo(m.role); }).map(function (m) { return m.code; }), createdBy: 'SYSTEM', createdAt: nowIso_() };
      writeChat_(c); chats.push(c); changed = true;
    } else if (c.memberCodes.indexOf(u.code) < 0) { c.memberCodes.push(u.code); writeChat_(c); changed = true; }
  }
  if (hasDeptBoard_(u.role)) ensure('GRP-DEPT', getConfigValue_('DepartmentName', 'Phòng Tổ chức Hành chính - Bệnh viện Nhi Đồng 2'), function (r) { return !isCrewRole_(r); });
  // [TC-HC] Bỏ nhóm chat 'Production Crew' (đã gỡ crew).
  return changed;
}

function listChats(token) {
  var u = requireUser_(token);
  ensureDefaultGroups_(u);
  var chats = readChats_().filter(function (c) { return isChatMember_(c, u.code); });
  var msgs = readMessages_();
  var lastBy = {}, countBy = {};
  msgs.forEach(function (m) { var p = lastBy[m.chatId]; if (!p || m.id > p.id) lastBy[m.chatId] = m; countBy[m.chatId] = (countBy[m.chatId] || 0) + 1; });
  var allMembers = readMembers_();
  var nameOf = {}; allMembers.forEach(function (m) { nameOf[m.code] = m.name; });
  var list = chats.map(function (c) {
    var other = (c.type === 'dm') ? (c.memberCodes.filter(function (x) { return x !== u.code; })[0] || '') : '';
    var disp = (c.type === 'dm') ? (nameOf[other] || other || 'Người dùng') : c.name;
    var last = lastBy[c.id] || null;
    return { id: c.id, type: c.type, name: disp, rawName: c.name, memberCodes: c.memberCodes, createdBy: c.createdBy, isSystem: c.createdBy === 'SYSTEM', otherCode: other,
      last: last ? { senderCode: last.senderCode, senderName: (nameOf[last.senderCode] || last.senderCode), kind: last.kind, body: last.kind === 'sticker' ? '[Sticker]' : last.body, createdAt: last.createdAt } : null,
      lastAt: last ? last.createdAt : c.createdAt, lastId: last ? last.id : 0, count: (countBy[c.id] || 0) };
  }).sort(function (a, b) { return String(b.lastAt || '').localeCompare(String(a.lastAt || '')); });
  // Roster để bắt đầu hội thoại mới (chỉ tên/vai trò — KHÔNG nhạy cảm).
  var roster = allMembers.filter(function (m) { return m.active && m.code !== u.code; }).map(function (m) { return { code: m.code, name: m.name, role: m.role, avatar: m.avatar || '' }; });
  // Trạng thái online cho mọi mã xuất hiện (đốm xanh/xám). Bản thân = online.
  var allCodes = allMembers.map(function (m) { return m.code; });
  var online = presenceMap_(allCodes); online[u.code] = true;
  return { chats: list, roster: roster, me: u.code, online: online };
}

function getMessages(token, chatId, sinceId) {
  var u = requireUser_(token);
  var chat = findChat_(readChats_(), String(chatId));
  if (!chat || !isChatMember_(chat, u.code)) throw err_('Bạn không có quyền xem hội thoại này.');
  var since = Number(sinceId) || 0;
  var msgs = readMessages_().filter(function (m) { return m.chatId === chat.id && m.id > since; }).sort(function (a, b) { return a.id - b.id; });
  var nm = {}; readMembers_().forEach(function (m) { nm[m.code] = m.name; });
  msgs.forEach(function (m) { m.senderName = nm[m.senderCode] || m.senderCode; });
  return { messages: msgs };
}

function sendMessage(token, chatId, kind, body) {
  var u = requireUser_(token);
  kind = (kind === 'sticker') ? 'sticker' : 'text';
  body = String(body == null ? '' : body).trim();
  if (!body) throw err_('Nội dung trống.');
  if (body.length > 4000) throw err_('Tin nhắn quá dài.');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var chat = findChat_(readChats_(), String(chatId));
    if (!chat || !isChatMember_(chat, u.code)) throw err_('Bạn không có quyền gửi vào hội thoại này.');
    var sh = getSheet_(SH_MESSAGES); var v = sh.getDataRange().getValues(); var maxId = 0;
    for (var i = 1; i < v.length; i++) { var n = Number(v[i][0]); if (n > maxId) maxId = n; }
    var msg = { id: maxId + 1, chatId: chat.id, senderCode: u.code, kind: kind, body: body, createdAt: nowIso_() };
    sh.appendRow([msg.id, msg.chatId, msg.senderCode, msg.kind, msg.body, msg.createdAt]);
    return msg;
  } finally { lock.releaseLock(); }
}

function createDM(token, otherCode) {
  var u = requireUser_(token);
  otherCode = String(otherCode || '').trim();
  var other = readMembers_().filter(function (m) { return m.code === otherCode && m.active; })[0];
  if (!other || other.code === u.code) throw err_('Người nhận không hợp lệ.');
  var chats = readChats_();
  var existing = chats.filter(function (c) { return c.type === 'dm' && c.memberCodes.length === 2 && c.memberCodes.indexOf(u.code) >= 0 && c.memberCodes.indexOf(other.code) >= 0; })[0];
  if (existing) return { id: existing.id };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var id = 'DM-' + uuid_().substring(0, 8);
    writeChat_({ id: id, type: 'dm', name: '', memberCodes: [u.code, other.code], createdBy: u.code, createdAt: nowIso_() });
    return { id: id };
  } finally { lock.releaseLock(); }
}

function createGroup(token, name, memberCodes) {
  var u = requireUser_(token);
  name = String(name || '').trim();
  if (!name) throw err_('Vui lòng nhập tên nhóm.');
  var active = {}; readMembers_().forEach(function (m) { if (m.active) active[m.code] = true; });
  var mem = [u.code];
  (Array.isArray(memberCodes) ? memberCodes : []).forEach(function (c) { c = String(c).trim(); if (active[c] && mem.indexOf(c) < 0) mem.push(c); });
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var id = 'GRP-' + uuid_().substring(0, 8);
    writeChat_({ id: id, type: 'group', name: name, memberCodes: mem, createdBy: u.code, createdAt: nowIso_() });
    return { id: id };
  } finally { lock.releaseLock(); }
}

function chatManageable_(chat, u) {
  if (!chat) throw err_('Không tìm thấy nhóm.');
  if (chat.type !== 'group') throw err_('Chỉ áp dụng cho nhóm.');
  if (chat.createdBy === 'SYSTEM') throw err_('Không thể chỉnh sửa nhóm mặc định của phòng.');
  if (chat.createdBy !== u.code) throw err_('Chỉ người tạo nhóm mới được quản lý nhóm.');
}
function renameGroup(token, chatId, name) {
  var u = requireUser_(token); name = String(name || '').trim(); if (!name) throw err_('Tên nhóm trống.');
  var chat = findChat_(readChats_(), String(chatId)); chatManageable_(chat, u);
  chat.name = name; writeChat_(chat); return { ok: true };
}
function addChatMembers(token, chatId, codes) {
  var u = requireUser_(token);
  var chat = findChat_(readChats_(), String(chatId)); chatManageable_(chat, u);
  var active = {}; readMembers_().forEach(function (m) { if (m.active) active[m.code] = true; });
  (Array.isArray(codes) ? codes : [codes]).forEach(function (c) { c = String(c).trim(); if (active[c] && chat.memberCodes.indexOf(c) < 0) chat.memberCodes.push(c); });
  writeChat_(chat); return { ok: true };
}
function removeChatMember(token, chatId, code) {
  var u = requireUser_(token); code = String(code || '').trim();
  var chat = findChat_(readChats_(), String(chatId)); chatManageable_(chat, u);
  if (code === chat.createdBy) throw err_('Không thể xoá người tạo nhóm.');
  chat.memberCodes = chat.memberCodes.filter(function (x) { return x !== code; });
  writeChat_(chat); return { ok: true };
}
function deleteGroup(token, chatId) {
  var u = requireUser_(token);
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var sh = getSheet_(SH_CHATS); var v = sh.getDataRange().getValues(); var rowIdx = -1, chat = null;
    for (var i = 1; i < v.length; i++) { if (String(v[i][0]).trim() === String(chatId)) { rowIdx = i; chat = chatObjFromRow_(v[i]); break; } }
    chatManageable_(chat, u);
    sh.deleteRow(rowIdx + 1);
    // Xoá tin nhắn của nhóm
    var ms = getSheet_(SH_MESSAGES); var mv = ms.getDataRange().getValues();
    for (var j = mv.length - 1; j >= 1; j--) { if (String(mv[j][1]).trim() === String(chatId)) ms.deleteRow(j + 1); }
    return { ok: true };
  } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------------------
// API: Trợ lý AI (proxy server-side tới Gemini) — KHÔNG lộ API key ra client.
// Cấu hình: Project Settings → Script properties → GEMINI_API_KEY (bắt buộc),
//           GEMINI_MODEL (tùy chọn, mặc định gemini-2.0-flash).
// ---------------------------------------------------------------------------
function aiGenerate(token, prompt) {
  requireUser_(token);
  prompt = String(prompt || '').trim();
  if (!prompt) throw err_('Thiếu nội dung yêu cầu AI.');

  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('GEMINI_API_KEY');
  if (!key) throw err_('Tính năng AI chưa được cấu hình. Quản trị viên hãy đặt GEMINI_API_KEY trong Script properties.');
  var model = props.getProperty('GEMINI_MODEL') || 'gemini-2.0-flash';

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
            encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);
  var payload = { contents: [{ parts: [{ text: prompt }] }] };

  var lastErr = '';
  for (var attempt = 0; attempt < 3; attempt++) {
    var resp = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    var codeHttp = resp.getResponseCode();
    if (codeHttp === 200) {
      var data = JSON.parse(resp.getContentText());
      var text = data &&
        data.candidates && data.candidates[0] &&
        data.candidates[0].content && data.candidates[0].content.parts &&
        data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
      if (text) return String(text);
      throw err_('AI không trả về nội dung. Vui lòng thử lại.');
    }
    lastErr = 'HTTP ' + codeHttp;
    if (codeHttp >= 400 && codeHttp < 500 && codeHttp !== 429) {
      throw err_('Lỗi gọi AI (' + codeHttp + '). Kiểm tra GEMINI_API_KEY / tên model.');
    }
    Utilities.sleep(800 * (attempt + 1));
  }
  throw err_('Không gọi được AI sau nhiều lần thử (' + lastErr + ').');
}
