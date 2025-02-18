require("dotenv").config();
const express = require("express");
const app = express();
const router = express.Router();
const compression = require("compression");
const mysql = require("mysql2/promise");
const morgan = require("morgan");
const path = require("path");
const axios = require("axios");

/***********************************************
 * 압축 미들웨어 적용 (가능한 최상단에 배치)
 ***********************************************/
app.use(compression());

/***********************************************
 * 0) View 설정
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
 * 0-1) 예시: 예약 현황 조회 라우트
 ***********************************************/
function getTodayKST() {
  const now = new Date();
  // KST 보정
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

    // 1) DB에서 예약 정보 가져오기 (이미 'ORDER BY start_time ASC' 포함)
    const [rows] = await pool.execute(
      `SELECT reserve_code, charger_type, start_time, end_time, masked_name
       FROM charger
       WHERE reserve_date = ?
       ORDER BY start_time ASC`,
      [today]
    );

    // 2) 전체 “카테고리->항목” 구조를 미리 선언
    //    (예약 여부와 무관하게, 모든 항목을 표시하기 위해)
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

    // 3) 우리가 UI에서 쓰는 “카테고리 이름”과
    //    DB상 charger_type(세부항목) 간의 매핑
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

    // 4) 실제 EJS 렌더링에 넘길 reservations 객체 초기화
    const reservations = {};
    for (const categoryName in allChargers) {
      reservations[categoryName] = {};
      allChargers[categoryName].forEach((itemName) => {
        reservations[categoryName][itemName] = [];
      });
    }

    // 5) DB에서 가져온 rows를 순회하며, 해당 카테고리/항목에 push
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

    // 6) reservations에 예약이 없는 항목도 빈 배열이 들어 있음
    res.render("charger", { reservations, today });
  } catch (err) {
    console.error(err);
    res.status(500).send("서버 오류");
  }
});

/***********************************************
 * 1) Morgan 로그 설정 (KST)
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

/***********************************************
 * 2) MySQL Pool
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
 * 3) Express + Router
 ***********************************************/
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(morgan("combined-kst"));
app.use("/reserve", router);

// Health check
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
router.post("/check/client_info", (req, res) => reserveClientInfoCheck(req.body, res));
router.post("/check/reserve_code",(req, res) => reserveCodeCheck(req.body, res));

// 예약 취소
router.post("/cancel", (req, res) => reserveCancel(req.body, res));

router.post("/certify", (req, res) => certify(req.body, res));
router.post("/certifycode", (req, res) => certifyCode(req.body, res));

/***********************************************
 재학생 인증
 ***********************************************/
// 재학생 인증 요청 처리 함수
function certify(reqBody, res) {
  const email = reqBody.value.origin;
  console.log("[DEBUG] Received email for certification:", email);

  // 중앙대 이메일 형식 검사
  if (!/^[^@]+@cau\.ac\.kr$/i.test(email)) {
    console.log("[DEBUG] 이메일 형식 검사 실패:", email);
    return res.send({
      "status": "FAIL",
      "message": "올바르지 않은 이메일 형식"
    });
  }

  // UnivCert API에 POST 요청을 위한 payload 준비
  const payload = {
    key: process.env.UNIVCERT,  // .env 파일에 UNIVCERT로 저장된 API 키
    email: email,
    univName: "중앙대학교",
    univ_check: true
  };
  console.log("[DEBUG] Payload for UnivCert API:", payload);

  axios.post("https://univcert.com/api/v1/certify", payload)
    .then((response) => {
      /*
        [공식 문서 예시 응답]
        - 성공 시 : { "success": true }
        - 실패 시 : { "status": 400, "success": false, "message": ... }
      */
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

// 인증 코드 검증 및 학생 정보 DB 저장 함수
async function certifyCode(reqBody, res) {
  console.log(reqBody);
  // 파라미터 파싱: code 값이 문자열로 전달되고, 숫자로만 이루어져 있지 않으면 오류 응답 전송
  const codeStr = reqBody.action.params.code;
  console.log(codeStr);
  if (!/^\d+$/.test(codeStr)) {
    return res.send({
      "version": "2.0",
      "template": {
        "outputs": [{
          "textCard": {
            "title": "올바르지 않은 인증 코드 형식입니다.",
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
  // 숫자로만 구성된 문자열을 정수형으로 변환
  const code = parseInt(codeStr, 10);

  const email = reqBody.action.params.email;
  const kakao_id = reqBody.userRequest.user.id;

  console.log("[DEBUG] certifyCode parameters:", { code, email, kakao_id });
  
  // UnivCert API에 POST할 payload 준비
  const payload = {
    key: process.env.UNIVCERT,  // .env에 저장된 "UNIVCERT" 키
    email: email,               // 인증대상 이메일
    univName: "중앙대학교",       // 중앙대라고 명시
    code: code                  // 사용자 입력 인증코드 (정수형)
  };

  console.log("[DEBUG] Payload for certifyCode UnivCert API:", payload);

  try {
    // UnivCert 인증코드 확인 요청
    const response = await axios.post("https://univcert.com/api/v1/certifycode", payload);
    const data = response.data;
    console.log("[DEBUG] Response from certifyCode UnivCert API:", data);

    if (data.success === true) {
      // 인증 성공 시, students 테이블에 INSERT
      let conn;
      try {
        conn = await pool.getConnection();
        console.log("[DEBUG] DB connection acquired");

        const insertQ = `
          INSERT INTO students (name, student_id, phone, email, kakao_id)
          VALUES (?,?,?,?,?)
        `;
        const clientInfo = reqBody.action.params.client_info ? parseClientInfo(reqBody.action.params.client_info) : { name: "", id: "", phone: "" };

        await conn.execute(insertQ, [
          clientInfo.name,
          clientInfo.id,
          clientInfo.phone,
          email,
          kakao_id
        ]);
        
        console.log("[DEBUG] Inserted student data for certification");
        conn.release();

        // 인증 성공 후, 카카오 챗봇 응답
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
        // DB 오류 시
        return res.send({
          "version": "2.0",
          "template": {
            "outputs": [{
              "textCard": {
                "title": "인증에 실패하였습니다.",
                "description": "다시 시도해주세요. (DB 오류)",
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
      // UnivCert 서버 응답이 200이지만 data.success=false 인 경우
      console.log("[DEBUG] 인증번호 불일치 혹은 기타 오류:", data.message);
      return res.send({
        "version": "2.0",
        "template": {
          "outputs": [{
            "textCard": {
              "title": "인증에 실패하였습니다.",
              "description": data.message || "다시 시도해주세요.",
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
    // 요청 자체가 실패했거나, 4xx / 5xx 에러인 경우
    console.error("[ERROR] certifyCode UnivCert API:", error.message);
    return res.send({
      "version": "2.0",
      "template": {
        "outputs": [{
          "textCard": {
            "title": "인증에 실패하였습니다.",
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
function parseClientInfo(str) {
  const cleaned = str.replace(/[\s-]/g, "");
  const parts = cleaned.split(",");
  return { name: parts[0], id: parts[1], phone: parts[2] };
}

function hideMiddleChar(str) {
  if (str.length < 3) return str[0] + "*";
  return str[0] + "*".repeat(str.length - 2) + str[str.length - 1];
}

// 30분 미만 or 4시간 초과시 잘못된 시간
function isWrongHours(st, et) {
  const [sh, sm] = st.split(":").map(Number);
  const [eh, em] = et.split(":").map(Number);
  const diff = eh * 60 + em - (sh * 60 + sm);
  return diff < 30 || diff > 240;
}

// 평일(월~금) 9시~22시만 가능
function isAvailableTime() {
  const now = new Date();
  const day = now.getDay(); // 0:일 ~ 6:토
  const hour = now.getHours();
  //if (day === 0 || day === 6) {
  //  console.log("[WARN] Weekend");
  //  return false;
  //}
  if (hour < 9 || hour >= 22) {
    console.log("[WARN] Out of hours");
    return false;
  }
  console.log("[INFO] isAvailableTime-> OK");
  return true;
}

/***********************************************
 * (X) "하루 1회" 중복 체크 함수
 ***********************************************/
function getCategoryInfo(rtype) {
  // New Media Library
  const newMediaArr = ["01BLUE","02GRAY","03SILVER","04GOLD"];
  // GLAB
  const glabArr     = ["GLAB1","GLAB2"];

  // 노트북 충전기
  const laptopArr   = ["노트북 충전기 (C-Type 65W) 1","노트북 충전기 (C-Type 65W) 2"];
  // 스마트폰 충전기
  const phoneCArr   = ["스마트폰 충전기 (C-Type) 1","스마트폰 충전기 (C-Type) 2","스마트폰 충전기 (C-Type) 3"];
  // 아이폰 충전기
  const iphoneArr   = ["아이폰 충전기 (8pin) 1","아이폰 충전기 (8pin) 2","아이폰 충전기 (8pin) 3"];
  // HDMI
  const hdmiArr     = ["HDMI 케이블 1","HDMI 케이블 2"];
  // 멀티탭 (3구 / 5구)
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

/**
 * "하루에 한 번" 제한 로직:
 *   - 당일에, 동일 카테고리(types 배열)에 속하는 room_type/charger_type 중
 *     이미 kakao_id로 예약(request_type='reserve')가 있으면 true
 */
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

    // 학생 정보 조회 (client_info 대신 students 테이블에서 조회)
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
              "title": "등록된 정보가 존재하지 않습니다.",
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

    // [추가] 같은 카테고리에 이미 예약이 있는지 체크
    const already = await checkDuplicateSameDay(room_type, dateStr, kakao_id, conn);
    if (already) {
      await conn.rollback();
      console.log("[WARN] same category duplication ->", room_type);
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"이미 예약 내역이 있습니다",
              "description":"같은 항목 대여는 하루에 1회 가능합니다.",
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }
          }]
        }
      });
    }

    // 어떤 테이블에 Insert할지
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

    // 예약 시간/조건 검증
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

    // 동시성 방지: 중복(SELECT ... FOR UPDATE)
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

    // 예약코드 생성
    const reserve_code = await generateReserveCode(room_type, conn);
    const hiddenName   = hideMiddleChar(student_info.name);

    // Insert
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

    // 커밋
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

    // 학생 정보 조회 (client_info 대신 students 테이블에서 조회)
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
              "title": "등록된 정보가 존재하지 않습니다.",
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

    // [추가] 같은 카테고리에 이미 예약이 있는지 체크
    const already = await checkDuplicateSameDay(category, dateStr, kakao_id, conn);
    if (already) {
      await conn.rollback();
      console.log("[WARN] same category duplication ->", category);
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"이미 예약 내역이 있습니다",
              "description":"같은 항목 대여는 하루에 1회 가능합니다.",
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }
          }]
        }
      });
    }

    // 납부자 검사
    if(await isNotPayer(client_info.name, client_info.id, conn)){
      await conn.rollback();
      console.log("[WARN] Not a payer");
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{
            "textCard":{
              "title":"학생회비 납부자가 아닙니다",
              "description":`이름:${client_info.name}\n학번:${client_info.id}`,
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

    // itemList 순회하며, 각 아이템에 대해 중복(SELECT ... FOR UPDATE) 체크
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

      // 빈 아이템이 있으면 그 아이템으로 예약
      if (overlapRows.length === 0) {
        const code = await generateReserveCode("CHARGER", conn);
        const hiddenName = hideMiddleChar(student_info.name);

        // 사물함 비밀번호
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

    // 모든 itemList가 예약 중인 경우
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
async function reserveStartTimeCheck(reqBody, res){
  console.log("[INFO] reserveStartTimeCheck");
  try {
    const st = reqBody.value.origin.slice(0,5);
    const now = new Date();
    const curMin = now.getHours()*60 + now.getMinutes();
    const [sh, sm] = st.split(":").map(Number);
    const startMin = sh*60 + sm;
    const diff = startMin - curMin;
    if(diff < 30 && diff < 0){
      console.log("[FAILED] Not available 30 min ago->", st);
      return res.send({ "status":"FAIL", "message":"30분 전 시간은 예약 불가" });
    }
    console.log("[SUCCESS] startTime->", st);
    res.send({ "status":"SUCCESS" });
  } catch(e) {
    console.error("[ERROR] reserveStartTimeCheck:", e);
    res.send({ "status":"FAIL", "message":"잘못된 요청" });
  }
}

async function reserveClientInfoCheck(reqBody, res) {
  console.log(reqBody);
  console.log("[INFO] reserveClientInfoCheck");
  try {
    const str = reqBody.value.origin;
    const cleaned = str.replace(/[\s-]/g, '');
    const parts = cleaned.split(',');
    if (parts.length !== 3) {
      console.log("[FAILED] Invalid client info->", str);
      return res.send({ "status": "FAIL", "message": "이름,학번,전화번호" });
    }
    const [name, sid, pho] = parts;
    if (!/^\d{8}$/.test(sid)) {
      console.log("[FAILED] Invalid studentID->", sid);
      return res.send({ "status": "FAIL", "message": "학번은 8자리" });
    }
    if (!/^\d{11}$/.test(pho)) {
      console.log("[FAILED] Invalid phone->", pho);
      return res.send({ "status": "FAIL", "message": "전화번호는 11자리" });
    }
    if (!name || name.length < 1) {
      console.log("[FAILED] Invalid name->", name);
      return res.send({ "status": "FAIL", "message": "이름을 입력" });
    }
    console.log("[SUCCESS] clientInfo->", name, sid, pho);

    // 카카오 아이디와 학생 정보 중복 체크
    const kakao_id = reqBody.userRequest.user.id;
    const [rows] = await pool.execute(
      "SELECT * FROM students WHERE kakao_id = ? OR (name = ? AND student_id = ? AND phone = ?)",
      [kakao_id, name, sid, pho]
    );
    if (rows.length > 0) {
      console.log("[FAILED] Duplicate student info found for kakao_id:", kakao_id, "or same student data", { name, sid, pho });
      return res.send({ "status": "FAIL", "message": "이미 등록된 학생 정보입니다." });
    }

    res.send({ "status": "SUCCESS" });
  } catch (e) {
    console.error("[ERROR] reserveClientInfoCheck:", e);
    res.send({ "status": "FAIL", "message": "잘못된 요청" });
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

  // logs
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

  // logs
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
 * (X) "하루 1회" 중복 체크 함수
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
 * 서버 실행
 ***********************************************/
const port = process.env.PORT || 8000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
