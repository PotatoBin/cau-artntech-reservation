require("dotenv").config();
const express = require("express");
const app = express();
const router = express.Router();
const compression = require("compression");
const mysql = require("mysql2/promise");
const morgan = require("morgan");
const path = require("path");
const axios = require("axios");
const helmet = require("helmet");

/***********************************************
 * 미들웨어 적용
 ***********************************************/
app.use(compression());
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/***********************************************
 * Morgan 로그 설정 (원본 그대로: 서버의 로컬 시간 기준)
 ***********************************************/
morgan.token("date-kst", () => {
  const now = new Date();
  const yyyy = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
});

morgan.format(
  "combined-kst",
  ':remote-addr - :remote-user [:date-kst] ":method :url HTTP/:http-version" :status :res[content-length] :response-time ms ":referrer" ":user-agent"'
);

app.use(morgan("combined-kst"));

/***********************************************
 * Anti-bot 미들웨어 (최상단에 배치)
 ***********************************************/
app.use((req, res, next) => {
  const userAgent = req.headers['user-agent'] || '';
  if (/selenium|headlesschrome|phantomjs|puppeteer|python-requests|bot|spider|crawl/i.test(userAgent)) {
    console.log(`[WARN] Blocked crawler/bot -> User-Agent: ${userAgent}`);
    return res.status(403).send('Forbidden');
  }
  next();
});

/***********************************************
 * 정적 파일, View 설정
 ***********************************************/
app.use("/img", express.static(path.join(__dirname, "img")));
app.use(express.static(path.join(__dirname, "public")));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.get("/", (req, res) => {
  return res.redirect("/view");
});

app.get("/view", (req, res) => {
  res.sendFile(path.join(__dirname, "view.html"));
});

/***********************************************
 * 예시: 예약 현황 조회 라우트
 ***********************************************/
function getTodayKST() {
  const now = new Date();
  // KST 보정 (웹사이트에만 적용)
  now.setHours(now.getHours() + 9);
  return now.toISOString().split('T')[0]; // "YYYY-MM-DD"
}

app.get("/view/newmedialibrary", async (req, res) => {
  try {
    const today = getTodayKST();
    const [rows] = await pool.execute(
      `SELECT reserve_code, room_type, start_time, end_time, masked_name 
       FROM new_media_library 
       WHERE reserve_date = ? 
       ORDER BY start_time ASC`,
      [today]
    );

    const reservations = {
      "01blue": [],
      "02gray": [],
      "03silver": [],
      "04gold": []
    };

    rows.forEach(row => {
      const roomKey = row.room_type.toLowerCase();
      if (reservations[roomKey]) {
        reservations[roomKey].push({
          time: row.start_time.slice(0,5) + " - " + row.end_time.slice(0,5),
          code: row.reserve_code,
          name: row.masked_name
        });
      }
    });

    res.render("newmedialibrary", { reservations, today });
  } catch (err) {
    console.error(err);
    res.status(500).send("서버 오류");
  }
});

app.get("/view/glab", async (req, res) => {
  try {
    const today = getTodayKST();
    const [rows] = await pool.execute(
      `SELECT reserve_code, room_type, start_time, end_time, masked_name
       FROM glab
       WHERE reserve_date = ?
       ORDER BY start_time ASC`,
      [today]
    );

    const reservations = {
      "glab1": [],
      "glab2": []
    };

    rows.forEach(row => {
      const key = row.room_type.toLowerCase();
      if (reservations[key]) {
        reservations[key].push({
          time: row.start_time.slice(0,5) + " - " + row.end_time.slice(0,5),
          code: row.reserve_code,
          name: row.masked_name
        });
      }
    });

    res.render("glab", { reservations, today });
  } catch (err) {
    console.error(err);
    res.status(500).send("서버 오류");
  }
});

app.get("/view/charger", async (req, res) => {
  try {
    const today = getTodayKST();

    const [rows] = await pool.execute(
      `SELECT reserve_code, charger_type, start_time, end_time, masked_name
       FROM charger
       WHERE reserve_date = ?
       ORDER BY start_time ASC`,
      [today]
    );

    const allChargers = {
      "노트북 충전기 (C-Type 65W)": [
        "노트북 충전기 (C-Type 65W) 1",
        "노트북 충전기 (C-Type 65W) 2"
      ],
      "스마트폰 충전기 (C-Type)": [
        "스마트폰 충전기 (C-Type) 1",
        "스마트폰 충전기 (C-Type) 2",
        "스마트폰 충전기 (C-Type) 3"
      ],
      "아이폰 충전기 (8pin)": [
        "아이폰 충전기 (8pin) 1",
        "아이폰 충전기 (8pin) 2",
        "아이폰 충전기 (8pin) 3"
      ],
      "HDMI 케이블": [
        "HDMI 케이블 1",
        "HDMI 케이블 2"
      ],
      "멀티탭 (3구)": [
        "멀티탭 (3구)"
      ],
      "멀티탭 (5구)": [
        "멀티탭 (5구)"
      ]
    };

    const categoryMapping = {
      "노트북 충전기 (C-Type 65W) 1": "노트북 충전기 (C-Type 65W)",
      "노트북 충전기 (C-Type 65W) 2": "노트북 충전기 (C-Type 65W)",
      "스마트폰 충전기 (C-Type) 1": "스마트폰 충전기 (C-Type)",
      "스마트폰 충전기 (C-Type) 2": "스마트폰 충전기 (C-Type)",
      "스마트폰 충전기 (C-Type) 3": "스마트폰 충전기 (C-Type)",
      "아이폰 충전기 (8pin) 1": "아이폰 충전기 (8pin)",
      "아이폰 충전기 (8pin) 2": "아이폰 충전기 (8pin)",
      "아이폰 충전기 (8pin) 3": "아이폰 충전기 (8pin)",
      "HDMI 케이블 1": "HDMI 케이블",
      "HDMI 케이블 2": "HDMI 케이블",
      "멀티탭 (3구)": "멀티탭 (3구)",
      "멀티탭 (5구)": "멀티탭 (5구)"
    };

    const reservations = {};
    for (const categoryName in allChargers) {
      reservations[categoryName] = {};
      allChargers[categoryName].forEach((itemName) => {
        reservations[categoryName][itemName] = [];
      });
    }

    rows.forEach(row => {
      const itemName = row.charger_type; 
      const category = categoryMapping[itemName];
      if (category) {
        reservations[category][itemName].push({
          time: row.start_time.slice(0, 5) + " - " + row.end_time.slice(0, 5),
          code: row.reserve_code,
          name: row.masked_name
        });
      }
    });

    res.render("charger", { reservations, today });
  } catch (err) {
    console.error(err);
    res.status(500).send("서버 오류");
  }
});

/***********************************************
 * MySQL Pool
 ***********************************************/
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

/***********************************************
 *  Router 설정
 ***********************************************/
app.use("/reserve", router);

/***********************************************
 * Health check
 ***********************************************/
router.head("/wakeup", (req, res) => {
  console.log("[INFO] wakeup endpoint called");
  res.status(200).send();
});

/***********************************************
 * Routes
 ***********************************************/
// 방(공간) 예약
router.post("/01BLUE",  (req, res) => reserve(req.body, res, "01BLUE"));
router.post("/02GRAY",  (req, res) => reserve(req.body, res, "02GRAY"));
router.post("/03SILVER",(req, res) => reserve(req.body, res, "03SILVER"));
router.post("/04GOLD",  (req, res) => reserve(req.body, res, "04GOLD"));
router.post("/GLAB1",   (req, res) => reserve(req.body, res, "GLAB1"));
router.post("/GLAB2",   (req, res) => reserve(req.body, res, "GLAB2"));

// 기존 충전기 라우트 → 물품 예약 통합
router.post("/CHARGER01", (req, res) => reserveItem(req.body, res, "노트북 충전기 (C-Type 65W)"));
router.post("/CHARGER02", (req, res) => reserveItem(req.body, res, "스마트폰 충전기 (C-Type)"));
router.post("/CHARGER03", (req, res) => reserveItem(req.body, res, "아이폰 충전기 (8pin)"));

// HDMI, 멀티탭
router.post("/HDMI",      (req, res) => reserveItem(req.body, res, "HDMI 케이블"));
router.post("/MULTITAP3", (req, res) => reserveItem(req.body, res, "멀티탭 (3구)"));
router.post("/MULTITAP5", (req, res) => reserveItem(req.body, res, "멀티탭 (5구)"));

// 유효성 검사
router.post("/check/start_time",  (req, res) => reserveStartTimeCheck(req.body, res));
router.post("/check/reserve_code",(req, res) => reserveCodeCheck(req.body, res));

// 예약 취소
router.post("/cancel", (req, res) => reserveCancel(req.body, res));

router.post("/check/name", (req, res) => checkClientName(req.body, res));
router.post("/check/student_id", (req, res) => checkClientStudentId(req.body, res));
router.post("/check/phone", (req, res) => checkClientPhone(req.body, res));

router.post("/certify", (req, res) => certify(req.body, res));
router.post("/certifycode", (req, res) => certifyCode(req.body, res));

/***********************************************
 * 재학생 인증
 ***********************************************/
function certify(reqBody, res) {
  const email = reqBody.value.origin;
  console.log("[DEBUG] Received email for certification:", email);

  if (!/^[^@]+@cau\.ac\.kr$/i.test(email)) {
    console.log("[DEBUG] 이메일 형식 검사 실패:", email);
    return res.send({
      "status": "FAIL",
      "message": "올바르지 않은 이메일 형식"
    });
  }

  const payload = {
    key: process.env.UNIVCERT,
    email: email,
    univName: "중앙대학교",
    univ_check: true
  };
  console.log("[DEBUG] Payload for UnivCert API:", payload);

  axios.post("https://univcert.com/api/v1/certify", payload)
    .then((response) => {
      const data = response.data;
      console.log("[DEBUG] Response from UnivCert API:", data);
      if (data.success === true) {
        return res.send({
          "status": "SUCCESS"
        });
      } else {
        return res.send({
          "status": "FAIL",
          "message": data.message || "인증 요청 실패"
        });
      }
    })
    .catch((error) => {
      console.error("[ERROR] UnivCert API:", error.message);
      return res.send({
        "status": "FAIL",
        "message": "인증 요청 실패"
      });
    });
}

async function certifyCode(reqBody, res) {
  console.log(reqBody);
  const codeStr = reqBody.action.params.code;
  console.log(codeStr);
  if (!/^\d+$/.test(codeStr)) {
    return res.send({
      "version": "2.0",
      "template": {
        "outputs": [{
          "textCard": {
            "title": "올바르지 않은 인증 코드 형식입니다",
            "description": "다시 시도해주세요.",
            "buttons": [{
              "label": "처음으로",
              "action": "block",
              "messageText": "처음으로"
            }]
          }
        }]
      }
    });
  }
  const code = parseInt(codeStr, 10);
  
  const email         = reqBody.action.params.email;
  const client_name   = reqBody.action.params.client_name;
  const client_id     = reqBody.action.params.client_id;
  const client_phone  = reqBody.action.params.client_phone;
  const kakao_id      = reqBody.userRequest.user.id;
  
  console.log("[DEBUG] certifyCode parameters:", { code, email, client_name, client_id, client_phone, kakao_id });
  
  const [rows] = await pool.execute(
    "SELECT * FROM student_master WHERE student_id = ? OR phone = ? OR email = ?",
    [client_id, client_phone, email]
  );
  
  if (rows.length > 0) {
    let fullyMatched = false;
    for (const record of rows) {
      if (
        record.student_id === client_id &&
        record.name === client_name &&
        record.phone === client_phone &&
        record.email === email
      ) {
        fullyMatched = true;
        break;
      }
    }
    if (!fullyMatched) {
      console.log("[ERROR] Provided student information does not match master record", {
        provided: { client_id, client_name, client_phone, email },
        found: rows
      });
      return res.send({
        "version": "2.0",
        "template": {
          "outputs": [{
            "textCard": {
              "title": "인증에 실패하였습니다",
              "description": "제공하신 정보가 재학생 정보와 일치하지 않습니다. 정확한 본인 정보를 기입해주세요.",
              "buttons": [{
                "label": "처음으로",
                "action": "block",
                "messageText": "처음으로"
              }]
            }
          }]
        }
      });
    }
  }
  
  const payload = {
    key: process.env.UNIVCERT,
    email: email,
    univName: "중앙대학교",
    code: code
  };
  
  console.log("[DEBUG] Payload for certifyCode UnivCert API:", payload);
  
  try {
    const response = await axios.post("https://univcert.com/api/v1/certifycode", payload);
    const data = response.data;
    console.log("[DEBUG] Response from certifyCode UnivCert API:", data);
    
    if (data.success === true) {
      let conn;
      try {
        conn = await pool.getConnection();
        console.log("[DEBUG] DB connection acquired");
        
        const insertQ = `
          INSERT INTO students (name, student_id, phone, email, kakao_id)
          VALUES (?,?,?,?,?)
        `;
        await conn.execute(insertQ, [
          client_name,
          client_id,
          client_phone,
          email,
          kakao_id
        ]);
        
        console.log("[DEBUG] Inserted student data for certification");
        conn.release();
        
        return res.send({
          "version": "2.0",
          "template": {
            "outputs": [{
              "textCard": {
                "title": "성공적으로 인증되었습니다",
                "description": `- 이메일: ${email}`,
                "buttons": [{
                  "label": "처음으로",
                  "action": "block",
                  "messageText": "처음으로"
                }]
              }
            }]
          }
        });
      } catch (dbErr) {
        if (conn) conn.release();
        console.error("[ERROR] DB Insert:", dbErr);
        return res.send({
          "version": "2.0",
          "template": {
            "outputs": [{
              "textCard": {
                "title": "인증에 실패하였습니다",
                "description": "DB 오류가 발생하였습니다. 다시 시도해주세요.",
                "buttons": [{
                  "label": "처음으로",
                  "action": "block",
                  "messageText": "처음으로"
                }]
              }
            }]
          }
        });
      }
    } else {
      console.log("[DEBUG] 인증번호 불일치 혹은 기타 오류:", data.message);
      return res.send({
        "version": "2.0",
        "template": {
          "outputs": [{
            "textCard": {
              "title": "인증에 실패하였습니다",
              "description": "인증번호가 일치하지 않습니다. 다시 시도해주세요.",
              "buttons": [{
                "label": "처음으로",
                "action": "block",
                "messageText": "처음으로"
              }]
            }
          }]
        }
      });
    }
  } catch (error) {
    console.error("[ERROR] certifyCode UnivCert API:", error.message);
    return res.send({
      "version": "2.0",
      "template": {
        "outputs": [{
          "textCard": {
            "title": "인증에 실패하였습니다",
            "description": "다시 시도해주세요.",
            "buttons": [{
              "label": "처음으로",
              "action": "block",
              "messageText": "처음으로"
            }]
          }
        }]
      }
    });
  }
}

/***********************************************
 * Helper 함수들
 ***********************************************/
function hideMiddleChar(str) {
  if (str.length < 3) return str[0] + "*";
  return str[0] + "*".repeat(str.length - 2) + str[str.length - 1];
}

function isWrongHours(st, et) {
  const [sh, sm] = st.split(":").map(Number);
  const [eh, em] = et.split(":").map(Number);
  const diff = eh * 60 + em - (sh * 60 + sm);
  return diff < 30 || diff > 240;
}

function isAvailableTime() {
  const now = new Date();
  const hour = now.getHours();
  // if (day === 0 || day === 6) {
  //   console.log("[WARN] Weekend");
  //   return false;
  // }
  if (hour < 9 || hour >= 22) {
    console.log("[WARN] Out of hours (KST)");
    return false;
  }
  console.log("[INFO] isAvailableTime-> OK (KST)");
  return true;
}

/***********************************************
 * "하루 1회" 중복 체크 함수
 ***********************************************/
function getCategoryInfo(rtype) {
  const newMediaArr = ["01BLUE","02GRAY","03SILVER","04GOLD"];
  const glabArr     = ["GLAB1","GLAB2"];
  const laptopArr   = ["노트북 충전기 (C-Type 65W) 1","노트북 충전기 (C-Type 65W) 2"];
  const phoneCArr   = ["스마트폰 충전기 (C-Type) 1","스마트폰 충전기 (C-Type) 2","스마트폰 충전기 (C-Type) 3"];
  const iphoneArr   = ["아이폰 충전기 (8pin) 1","아이폰 충전기 (8pin) 2","아이폰 충전기 (8pin) 3"];
  const hdmiArr     = ["HDMI 케이블 1","HDMI 케이블 2"];
  const multiArr    = ["멀티탭 (3구)","멀티탭 (5구)"];

  if (newMediaArr.includes(rtype)) {
    return {
      table: "new_media_library",
      column: "room_type",
      types: newMediaArr
    };
  } else if (glabArr.includes(rtype)) {
    return {
      table: "glab",
      column: "room_type",
      types: glabArr
    };
  } else if (rtype === "노트북 충전기 (C-Type 65W)" || laptopArr.includes(rtype)) {
    return {
      table: "charger",
      column: "charger_type",
      types: laptopArr
    };
  } else if (rtype === "스마트폰 충전기 (C-Type)" || phoneCArr.includes(rtype)) {
    return {
      table: "charger",
      column: "charger_type",
      types: phoneCArr
    };
  } else if (rtype === "아이폰 충전기 (8pin)" || iphoneArr.includes(rtype)) {
    return {
      table: "charger",
      column: "charger_type",
      types: iphoneArr
    };
  } else if (rtype === "HDMI 케이블" || hdmiArr.includes(rtype)) {
    return {
      table: "charger",
      column: "charger_type",
      types: hdmiArr
    };
  } else if (
    rtype === "멀티탭 (3구)" ||
    rtype === "멀티탭 (5구)" ||
    multiArr.includes(rtype)
  ) {
    return {
      table: "charger",
      column: "charger_type",
      types: multiArr
    };
  }
  return null;
}

async function checkDuplicateSameDay(rtype, dateStr, kakao_id, conn){
  const info = getCategoryInfo(rtype);
  if(!info) {
    return false; 
  }

  const { table, column, types } = info;
  const placeholders = types.map(() => "?").join(",");

  const sql = `
    SELECT n.reserve_code
    FROM ${table} AS n
    JOIN logs AS l
      ON n.reserve_code = l.reserve_code
    WHERE n.reserve_date = ?
      AND l.kakao_id = ?
      AND l.request_type = 'reserve'
      AND n.${column} IN (${placeholders})
    LIMIT 1
  `;
  const params = [dateStr, kakao_id, ...types];
  const [rows] = await conn.execute(sql, params);

  return (rows.length > 0);
}

/***********************************************
 * (A) 방/GLAB 예약 (동시성 방지 + 중복확인)
 ***********************************************/
async function reserve(reqBody, res, room_type) {
  console.log("[INFO] reserve() ->", room_type);
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const start_time_str = JSON.parse(reqBody.action.params.start_time).value;
    const end_time_str   = JSON.parse(reqBody.action.params.end_time).value;
    const kakao_id       = reqBody.userRequest.user.id;

    const [studentRows] = await conn.execute(
      "SELECT name, student_id, phone FROM students WHERE kakao_id = ?",
      [kakao_id]
    );
    if (studentRows.length === 0) {
      await conn.rollback();
      console.log("[ERROR] Student info not found for kakao_id ->", kakao_id);
      return res.send({
        "version": "2.0",
        "template": {
          "outputs": [{
            "textCard": {
              "title": "등록된 정보가 존재하지 않습니다",
              "description": "재학생 인증이 필요합니다.",
              "buttons": [{
                "label": "재학생 인증",
                "action": "block",
                "messageText": "재학생 인증"
              }]
            }
          }]
        }
      });
    }
    const student_info = studentRows[0];

    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const start_db = start_time_str;
    const end_db   = end_time_str;
    const displayTime = `${start_time_str.slice(0,5)} - ${end_time_str.slice(0,5)}`;

    const already = await checkDuplicateSameDay(room_type, dateStr, kakao_id, conn);
    if (already) {
      await conn.rollback();
      console.log("[WARN] same category duplication ->", room_type);
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"오늘 이미 다른 방을 예약한 내역이 있습니다",
              "description":"같은 항목 대여는 하루에 1회 가능합니다.",
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }
          }]
        }
      });
    }

    let table;
    if (["01BLUE","02GRAY","03SILVER","04GOLD"].includes(room_type)) {
      table = "new_media_library";
    } else if (["GLAB1","GLAB2"].includes(room_type)) {
      table = "glab";
    } else {
      await conn.rollback();
      console.log("[FAIL] Invalid room_type->", room_type);
      return res.send({
        status:"FAIL",
        message:"잘못된 방 유형"
      });
    }

    if (!isAvailableTime()) {
      await conn.rollback();
      console.log("[WARN] not available time");
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"현재 예약할 수 없는 시간입니다",
              "description":"평일 9시~22시까지만 당일 예약",
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }
          }]
        }
      });
    }
    if (isWrongHours(start_time_str, end_time_str)) {
      await conn.rollback();
      console.log("[WARN] Wrong hours");
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"30분부터 최대4시간 신청 가능합니다",
              "description":`요청시간: ${displayTime}`,
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }
          }]
        }
      });
    }

    const col = "room_type";
    const overlapSql = `
      SELECT id
      FROM ${table}
      WHERE
        reserve_date = ?
        AND ${col} = ?
        AND start_time < ?
        AND end_time > ?
      FOR UPDATE
    `;
    const [overlapRows] = await conn.execute(overlapSql, [
      dateStr, room_type, end_db, start_db
    ]);

    if (overlapRows.length > 0) {
      await conn.rollback();
      console.log("[WARN] Overlap->", room_type);
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"해당 일시에 겹치는 예약이 있습니다",
              "description":`- 방:${room_type}\n- 시간:${displayTime}`,
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }
          }]
        }
      });
    }

    const reserve_code = await generateReserveCode(room_type, conn);
    const hiddenName   = hideMiddleChar(student_info.name);

    await addToDatabase(
      table,
      reserve_code,
      room_type,
      dateStr,
      start_db,
      end_db,
      hiddenName,
      student_info,
      kakao_id,
      conn
    );

    await conn.commit();
    console.log("[SUCCESS] Reserved->", reserve_code);

    return res.send({
      "version":"2.0",
      "template":{
        "outputs":[{
          "textCard":{
            "title":"성공적으로 예약되었습니다",
            "description":`- 방: ${room_type}\n- 예약번호: ${reserve_code}\n- 시간: ${displayTime}\n- 신청자: ${hiddenName}`,
            "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
          }
        }]
      }
    });
  } catch (err) {
    console.error("[ERROR] reserve:", err);
    if (conn) await conn.rollback();
    return res.send({status:"FAIL", message:"예약 처리 중 오류"});
  } finally {
    if (conn) conn.release();
  }
}

/***********************************************
 * (B) 물품 예약 (충전기/HDMI/멀티탭 등)
 ***********************************************/
const itemMap = {
  "노트북 충전기 (C-Type 65W)": [
    "노트북 충전기 (C-Type 65W) 1",
    "노트북 충전기 (C-Type 65W) 2"
  ],
  "스마트폰 충전기 (C-Type)": [
    "스마트폰 충전기 (C-Type) 1",
    "스마트폰 충전기 (C-Type) 2",
    "스마트폰 충전기 (C-Type) 3"
  ],
  "아이폰 충전기 (8pin)": [
    "아이폰 충전기 (8pin) 1",
    "아이폰 충전기 (8pin) 2",
    "아이폰 충전기 (8pin) 3"
  ],
  "HDMI 케이블": [
    "HDMI 케이블 1",
    "HDMI 케이블 2"
  ],
  "멀티탭 (3구)": [
    "멀티탭 (3구)"
  ],
  "멀티탭 (5구)": [
    "멀티탭 (5구)"
  ]
};

async function reserveItem(reqBody, res, category) {
  console.log("[INFO] reserveItem() ->", category);
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const start_time_str = JSON.parse(reqBody.action.params.start_time).value;
    const end_time_str   = JSON.parse(reqBody.action.params.end_time).value;
    const kakao_id       = reqBody.userRequest.user.id;

    const [studentRows] = await conn.execute(
      "SELECT name, student_id, phone FROM students WHERE kakao_id = ?",
      [kakao_id]
    );
    if (studentRows.length === 0) {
      await conn.rollback();
      console.log("[ERROR] Student info not found for kakao_id ->", kakao_id);
      return res.send({
        "version": "2.0",
        "template": {
          "outputs": [{
            "textCard": {
              "title": "등록된 정보가 존재하지 않습니다",
              "description": "재학생 인증이 필요합니다.",
              "buttons": [{
                "label": "재학생 인증",
                "action": "block",
                "messageText": "재학생인증"
              }]
            }
          }]
        }
      });
    }
    const student_info = studentRows[0];

    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const start_db = start_time_str;
    const end_db   = end_time_str;
    const displayTime = `${start_time_str.slice(0,5)} - ${end_time_str.slice(0,5)}`;

    const already = await checkDuplicateSameDay(category, dateStr, kakao_id, conn);
    if (already) {
      await conn.rollback();
      console.log("[WARN] same category duplication ->", category);
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"오늘 이미 같은 물품을 예약한 내역이 있습니다",
              "description":"같은 항목 대여는 하루에 1회 가능합니다.",
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }
          }]
        }
      });
    }

    if(await isNotPayer(student_info.name, student_info.id, conn)){
      await conn.rollback();
      console.log("[WARN] Not a payer");
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"학생회비 납부자가 아닙니다",
              "description":`이름:${student_info.name}\n학번:${student_info.id}`,
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }
          }]
        }
      });
    }

    if(!isAvailableTime()){
      await conn.rollback();
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"현재 예약할 수 없는 시간입니다",
              "description":"평일 9시~22시 당일만 가능",
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }
          }]
        }
      });
    }
    if(isWrongHours(start_time_str,end_time_str)){
      await conn.rollback();
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"30분부터 최대4시간까지 신청 가능합니다",
              "description":`- 물품:${category}\n- 요청 시간:${displayTime}`,
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }
          }]
        }
      });
    }

    const itemList = itemMap[category];
    if(!itemList){
      await conn.rollback();
      console.log("[FAIL] Unknown item category->", category);
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"예약이 불가능한 물품입니다",
              "description":`카테고리:${category}`,
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }
          }]
        }
      });
    }

    for(const itemName of itemList){
      const overlapSql = `
        SELECT id
        FROM charger
        WHERE
          reserve_date=?
          AND charger_type=?
          AND start_time < ?
          AND end_time > ?
        FOR UPDATE
      `;
      const [overlapRows] = await conn.execute(overlapSql, [
        dateStr, itemName, end_db, start_db
      ]);

      if (overlapRows.length === 0) {
        const code = await generateReserveCode("CHARGER", conn);
        const hiddenName = hideMiddleChar(student_info.name);

        const locker_pwd = await getLockerPassword(itemName, conn);

        await addToDatabaseCharger(
          "charger",
          code,
          itemName,
          dateStr,
          start_db,
          end_db,
          hiddenName,
          student_info,
          kakao_id,
          conn
        );

        await conn.commit();
        console.log("[SUCCESS] Reserved item->", itemName);

        return res.send({
          "version":"2.0",
          "template":{
            "outputs":[{
              "textCard":{
                "title":"성공적으로 대여하였습니다",
                "description":
                  `- ${itemName}\n` +
                  `- 사물함 비밀번호: ${locker_pwd}\n` +
                  `- 예약 번호: ${code}\n` +
                  `- 대여 시간: ${displayTime}\n` +
                  `- 신청자: ${hiddenName}\n\n` +
                  `사용 후 반드시 제자리에!\n`,
                "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
              }
            }]
          }
        });
      }
    }

    await conn.rollback();
    console.log("[WARN] All items used->", category);
    return res.send({
      "version":"2.0",
      "template":{
        "outputs":[{
          "textCard":{
            "title":"모든 물품이 사용중입니다",
            "description":`- 물품:${category}\n- 요청 시간:${displayTime}`,
            "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
          }
        }]
      }
    });

  } catch(err){
    console.error("[ERROR] reserveItem:", err);
    if (conn) await conn.rollback();
    return res.send({status:"FAIL", message:"물품 예약 중 오류"});
  } finally {
    if (conn) conn.release();
  }
}

/***********************************************
 * (C) 예약 취소
 ***********************************************/
async function reserveCancel(reqBody, res) {
  console.log("[INFO] reserveCancel() called");
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const reserve_code = reqBody.action.params.reserve_code;
    const kakao_id = reqBody.userRequest.user.id;
    console.log("[DEBUG] code=", reserve_code, "kakao_id=", kakao_id);

    const queryLogs = `SELECT * FROM logs WHERE reserve_code=? AND request_type='reserve'`;
    const [rows] = await conn.execute(queryLogs, [reserve_code]);
    if (!rows.length) {
      await conn.rollback();
      console.log("[FAILED] No matching code->", reserve_code);
      const d = `다시 시도해주세요.`;
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"예약번호와 일치하는 예약이 없습니다",
              "description":d,
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }
          }]
        }
      });
    }

    const logRow = rows[0];
    if(logRow.kakao_id !== kakao_id){
      await conn.rollback();
      console.log("[FAILED] Another person's code->", reserve_code);
      const d = `신청자의 카카오톡 계정으로 취소해주세요.`;
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"신청자 본인이 아닙니다",
              "description":d,
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }
          }]
        }
      });
    }

    let table;
    const c = reserve_code[0];
    if(["1","2","3","4"].includes(c)) {
      table = "new_media_library";
    } else if(["5","6"].includes(c)) {
      table = "glab";
    } else if(["7"].includes(c)) {
      table = "charger";
    } else {
      await conn.rollback();
      console.log("[FAILED] Unknown prefix->", c);
      const d = `다시 시도해주세요.`;
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"잘못된 예약코드입니다",
              "description":d,
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }
          }]
        }
      });
    }

    const checkQ = `SELECT * FROM ${table} WHERE reserve_code=? FOR UPDATE`;
    const [checkRows] = await conn.execute(checkQ, [reserve_code]);
    if(!checkRows.length) {
      await conn.rollback();
      console.log("[FAILED] Already canceled->", reserve_code);
      const d = `다시 시도해주세요.`;
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"이미 취소된 예약입니다",
              "description":d,
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }
          }]
        }
      });
    }

    const delQ = `DELETE FROM ${table} WHERE reserve_code=?`;
    await conn.execute(delQ, [reserve_code]);

    const logQ = `
      INSERT INTO logs (reserve_code, room_type, request_type, name, student_id, phone, kakao_id)
      VALUES(?,?,?,?,?,?,?)
    `;
    await conn.execute(logQ, [
      logRow.reserve_code,
      logRow.room_type,
      "cancel",
      logRow.name,
      logRow.student_id,
      logRow.phone,
      logRow.kakao_id
    ]);

    await conn.commit();

    const origin = checkRows[0];
    const st = origin.start_time.slice(0,5);
    const et = origin.end_time.slice(0,5);
    const time_string = `${st} - ${et}`;
    const hiddenName = origin.masked_name;
    const d = `- ${logRow.room_type}\n- 예약 번호: ${reserve_code}\n- 대여 시간: ${time_string}\n- 신청자: ${hiddenName}`;

    res.send({
      "version":"2.0",
      "template":{
        "outputs":[{
          "textCard":{
            "title":"대여를 취소했습니다",
            "description":d,
            "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
          }
        }]
      }
    });
    console.log("[SUCCESS] reserveCancel->", reserve_code);

  } catch(err) {
    console.error("[ERROR] reserveCancel:", err);
    if (conn) await conn.rollback();
    return res.send({ "status":"FAIL", "message":"예약 취소 중 오류" });
  } finally {
    if (conn) conn.release();
  }
}

/***********************************************
 * (D) 유효성 검사
 ***********************************************/
async function reserveStartTimeCheck(reqBody, res) {
  console.log("[INFO] reserveStartTimeCheck 호출됨");
  try {
    const st = reqBody.value.origin.slice(0, 5);
    const now = new Date();
    const curMin = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = st.split(":").map(Number);
    const startMin = sh * 60 + sm;
    const diff = startMin - curMin;
    
    // 예약 시작 시간이 현재 시각보다 이후여야 함 (0분 이하이면 실패)
    if (diff <= 0) {
      console.log("[FAILED] 예약 시작 시간이 현재 KST 시각 이후여야 합니다 ->", st);
      return res.send({
        "status": "FAIL",
        "message": "예약 시작 시간은 현재 시각 이후여야 합니다."
      });
    }
    console.log("[SUCCESS] 예약 시작 시간 검증 통과:", st);
    res.send({ "status": "SUCCESS" });
  } catch (e) {
    console.error("[ERROR] reserveStartTimeCheck:", e);
    res.send({ "status": "FAIL", "message": "잘못된 요청" });
  }
}

async function checkClientName(reqBody, res) {
  console.log("[INFO] checkClientName", reqBody);
  try {
    const name = reqBody.value.origin.trim();
    const kakao_id = reqBody.user.id;
    
    const [rows] = await pool.execute("SELECT * FROM students WHERE kakao_id = ?", [kakao_id]);
    if (rows.length > 0) {
      console.log("[FAILED] 이미 등록된 카카오 아이디:", kakao_id);
      return res.send({ "status": "FAIL", "message": "이미 인증된 학생 정보가 있습니다." });
    }
    console.log("[SUCCESS] 이름 검증 통과:", name);
    res.send({ "status": "SUCCESS", "message": "이름 검증 성공" });
  } catch (e) {
    console.error("[ERROR] checkClientName:", e);
    res.send({ "status": "FAIL", "message": "이름 검증 중 오류" });
  }
}

function checkClientStudentId(reqBody, res) {
  console.log("[INFO] checkClientStudentId", reqBody);
  try {
    const sid = reqBody.value.origin.trim();
    if (!/^\d{8}$/.test(sid)) {
      console.log("[FAILED] 학번 형식 오류:", sid);
      return res.send({ "status": "FAIL", "message": "학번은 8자리 숫자여야 합니다." });
    }
    const year = parseInt(sid.substring(0, 4), 10);
    if (year <= 2015 || year >= 2025) {
      console.log("[FAILED] 입학년도 오류:", sid);
      return res.send({ "status": "FAIL", "message": "학번의 입학년도는 2016부터 2024 사이여야 합니다." });
    }
    if (sid.endsWith("0000")) {
      console.log("[FAILED] 가짜 학번 감지:", sid);
      return res.send({ "status": "FAIL", "message": "가짜 학번입니다." });
    }
    console.log("[SUCCESS] 학번 검증 통과:", sid);
    res.send({ "status": "SUCCESS", "message": "학번 검증 성공" });
  } catch (e) {
    console.error("[ERROR] checkClientStudentId:", e);
    res.send({ "status": "FAIL", "message": "학번 검증 중 오류" });
  }
}

function checkClientPhone(reqBody, res) {
  console.log("[INFO] checkClientPhone", reqBody);
  try {
    const phone = reqBody.value.origin.trim();
    if (!/^\d{11}$/.test(phone)) {
      console.log("[FAILED] 전화번호 형식 오류 (11자리 아님):", phone);
      return res.send({ "status": "FAIL", "message": "전화번호는 11자리 숫자여야 합니다." });
    }
    if (!phone.startsWith("010")) {
      console.log("[FAILED] 전화번호 시작 오류 (010 아님):", phone);
      return res.send({ "status": "FAIL", "message": "전화번호는 010으로 시작해야 합니다." });
    }
    console.log("[SUCCESS] 전화번호 검증 통과:", phone);
    res.send({ "status": "SUCCESS", "message": "전화번호 검증 성공" });
  } catch (e) {
    console.error("[ERROR] checkClientPhone:", e);
    res.send({ "status": "FAIL", "message": "전화번호 검증 중 오류" });
  }
}

async function reserveCodeCheck(reqBody, res){
  console.log("[INFO] reserveCodeCheck");
  let conn;
  try {
    const code = reqBody.value.origin;
    if(!/^\d{6}$/.test(code)){
      console.log("[FAILED] Invalid code->", code);
      return res.send({"status":"FAIL","message":"올바른 형식 아님"});
    }

    conn = await pool.getConnection();
    const q = `SELECT * FROM logs WHERE reserve_code=?`;
    const [rows] = await conn.execute(q, [code]);
    if(!rows.length){
      console.log("[FAILED] code not found->", code);
      return res.send({"status":"FAIL","message":"존재하지 않는 예약코드"});
    }
    console.log("[SUCCESS] code->", code);
    res.send({"status":"SUCCESS"});

  } catch(e) {
    console.error("[ERROR] reserveCodeCheck:", e);
    res.send({"status":"FAIL","message":"잘못된 요청"});
  } finally {
    if (conn) conn.release();
  }
}

/***********************************************
 * (E) DB Insert / GenerateReserveCode
 ***********************************************/
async function addToDatabase(table, code, rtype, rDate, stime, etime, maskedName, client_info, kakao_id, conn){
  console.log("[INFO] addToDatabase->", table, code);

  const insertQ = `
    INSERT INTO ${table} (
      reserve_code, room_type, reserve_date,
      start_time, end_time, masked_name
    ) VALUES(?,?,?,?,?,?)
  `;
  await conn.execute(insertQ, [
    code,
    rtype,
    rDate,
    stime,
    etime,
    maskedName
  ]);

  const logQ = `
    INSERT INTO logs (
      reserve_code, room_type, request_type,
      name, student_id, phone, kakao_id
    ) VALUES(?,?,?,?,?,?,?)
  `;
  await conn.execute(logQ, [
    code,
    rtype,
    "reserve",
    client_info.name,
    client_info.student_id,
    client_info.phone,
    kakao_id
  ]);
}

async function addToDatabaseCharger(table, code, itemName, rDate, stime, etime, masked, info, kakao_id, conn) {
  console.log("[INFO] addToDatabaseCharger->", itemName, code);

  const insertQ = `
    INSERT INTO ${table} (
      reserve_code, charger_type, reserve_date,
      start_time, end_time, masked_name
    ) VALUES(?,?,?,?,?,?)
  `;
  await conn.execute(insertQ, [
    code,
    itemName,
    rDate,
    stime,
    etime,
    masked
  ]);

  const logQ = `
    INSERT INTO logs (
      reserve_code, room_type, request_type,
      name, student_id, phone, kakao_id
    ) VALUES(?,?,?,?,?,?,?)
  `;
  await conn.execute(logQ, [
    code,
    itemName,
    "reserve",
    info.name,
    info.student_id,
    info.phone,
    kakao_id
  ]);
}

/***********************************************
 * (F) 코드 생성 (트랜잭션 인자)
 ***********************************************/
async function generateReserveCode(rtype, conn) {
  console.log("[INFO] generateReserveCode->", rtype);
  const room_codes = {
    "01BLUE": "1", "02GRAY": "2", "03SILVER": "3", "04GOLD": "4",
    "GLAB1": "5", "GLAB2": "6"
  };
  const prefix = (rtype === "CHARGER") ? "7" : (room_codes[rtype] || "9");

  const q = `
    SELECT MAX(CAST(SUBSTRING(reserve_code,2) AS UNSIGNED)) AS max_id
    FROM logs
    WHERE reserve_code LIKE '${prefix}%'
      AND request_type='reserve'
    FOR UPDATE
  `;
  const [rows] = await conn.execute(q);
  let maxID = rows[0].max_id;
  if (!maxID) maxID = 0;
  const newID = maxID + 1;
  const code = prefix + String(newID).padStart(5, "0");
  console.log("[INFO] new code->", code);
  return code;
}

/***********************************************
 * (G) 납부자/사물함 비번
 ***********************************************/
async function isNotPayer(name, id, conn) {
  console.log("[INFO] isNotPayer->", name, id);
  const q = `SELECT * FROM payers WHERE student_id=? AND name=?`;
  const [rows] = await conn.execute(q, [id, name]);
  console.log("[DEBUG] payers found->", rows.length);
  return rows.length === 0;
}

async function getLockerPassword(ctype, conn) {
  console.log("[INFO] getLockerPassword->", ctype);
  const q = `SELECT password FROM charger_lockers WHERE charger_type=?`;
  const [rows] = await conn.execute(q, [ctype]);
  if (!rows.length) {
    console.log("[WARN] No locker found->", ctype);
    return "0000";
  }
  return rows[0].password;
}

/***********************************************
 * 서버 실행
 ***********************************************/
const port = process.env.PORT || 8000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
