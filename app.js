require("dotenv").config();
const express = require('express');
const app = express();
const router = express.Router();
const mysql = require('mysql2/promise');
const morgan = require('morgan');

/***********************************************
 * 1) Morgan (서버가 KST면 new Date()가 KST)
 ***********************************************/
morgan.token('date-kst', () => {
  const now = new Date();
  const yyyy = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
});
morgan.format('combined-kst',
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
 * 3) Express
 ***********************************************/
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(morgan('combined-kst'));
app.use('/reserve', router);

// Health check
router.head('/wakeup', (req, res) => {
  console.log("[INFO] wakeup endpoint called");
  res.status(200).send();
});

/***********************************************
 * Routes
 ***********************************************/

// 방(공간) 예약
router.post('/01BLUE',  (req, res) => reserve(req.body, res, '01BLUE'));
router.post('/02GRAY',  (req, res) => reserve(req.body, res, '02GRAY'));
router.post('/03SILVER',(req, res) => reserve(req.body, res, '03SILVER'));
router.post('/04GOLD',  (req, res) => reserve(req.body, res, '04GOLD'));
router.post('/GLAB1',   (req, res) => reserve(req.body, res, 'GLAB1'));
router.post('/GLAB2',   (req, res) => reserve(req.body, res, 'GLAB2'));

// 충전기 예약
router.post('/CHARGER01',(req, res) => reserveCharger(req.body, res, '노트북 충전기 (C-Type 65W)'));
router.post('/CHARGER02',(req, res) => reserveCharger(req.body, res, '스마트폰 충전기 (C-Type)'));
router.post('/CHARGER03',(req, res) => reserveCharger(req.body, res, '아이폰 충전기 (8pin)'));

// 유효성 검사
router.post('/check/start_time',  (req, res) => reserveStartTimeCheck(req.body, res));
router.post('/check/client_info', (req, res) => reserveClientInfoCheck(req.body, res));
router.post('/check/reserve_code',(req, res) => reserveCodeCheck(req.body, res));

// 예약 취소
router.post('/cancel', (req, res) => reserveCancel(req.body, res));

/***********************************************
 * Helper
 ***********************************************/
function parseClientInfo(str) {
  const cleaned = str.replace(/[\s-]/g, '');
  const parts = cleaned.split(',');
  return { name: parts[0], id: parts[1], phone: parts[2] };
}
function hideMiddleChar(str) {
  if (str.length < 3) return str[0] + '*';
  return str[0] + '*'.repeat(str.length - 2) + str[str.length - 1];
}
function isWrongHours(st, et) {
  const [sh, sm] = st.split(':').map(Number);
  const [eh, em] = et.split(':').map(Number);
  const diff = (eh*60 + em) - (sh*60 + sm);
  return diff < 30 || diff > 240; // 30분 미만 또는 4시간 초과
}
function isAvailableTime() {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();
  if (day === 0 || day === 6) {
    console.log("[WARN] Weekend");
    return false;
  }
  if (hour < 9 || hour >= 22) {
    console.log("[WARN] Out of hours");
    return false;
  }
  console.log("[INFO] isAvailableTime-> OK");
  return true;
}

/***********************************************
 * (A) 방/GLAB 예약
 ***********************************************/
async function reserve(reqBody, res, room_type){
  console.log("[INFO] reserve() ->", room_type);
  try {
    const start_time_str = JSON.parse(reqBody.action.params.start_time).value; // 예 "16:30"
    const end_time_str   = JSON.parse(reqBody.action.params.end_time).value;   // 예 "18:30"
    const client_info    = parseClientInfo(reqBody.action.params.client_info);
    const kakao_id       = reqBody.userRequest.user.id;
    
    // 날짜: "YYYY-MM-DD"
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];  // e.g. "2025-02-05"

    // TIME: "HH:MM:SS"
    const start_db = `${start_time_str}:00`;  // "16:30:00"
    const end_db   = `${end_time_str}:00`;    // "18:30:00"

    const displayTime = `${start_time_str} - ${end_time_str}`;

    // 어떤 테이블인지
    let table;
    if(['01BLUE','02GRAY','03SILVER','04GOLD'].includes(room_type)) table='new_media_library';
    else if(['GLAB1','GLAB2'].includes(room_type)) table='glab';
    else {
      console.log("[FAIL] Invalid room_type->", room_type);
      return res.send({status:"FAIL", message:"잘못된 방 유형"});
    }

    // 시간 체크
    if(!isAvailableTime()){
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{"textCard":{
            "title":"현재 예약할 수 없는 시간입니다",
            "description":"평일 9시~22시까지만 당일 예약"
          }}]
        }
      });
    }
    if(isWrongHours(start_time_str,end_time_str)){
      console.log("[WARN] Wrong hours");
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{"textCard":{
            "title":"30분부터 최대4시간 신청 가능합니다",
            "description":`요청시간: ${displayTime}`
          }}]
        }
      });
    }

    // 중복 검사
    if(await checkOverlap(table, dateStr, start_db, end_db, room_type)){
      console.log("[WARN] Overlap->", room_type);
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{"textCard":{
            "title":"해당 일시에 겹치는 예약이 있습니다",
            "description":`- 방:${room_type}\n- 시간:${displayTime}`
          }}]
        }
      });
    }

    // 예약 코드 생성
    const reserve_code = await generateReserveCode(room_type);
    const hiddenName   = hideMiddleChar(client_info.name);

    // DB 저장
    await addToDatabase(table, reserve_code, room_type, dateStr, start_db, end_db, hiddenName, client_info, kakao_id);
    console.log("[SUCCESS] Reserved->", reserve_code);

    // 응답
    return res.send({
      "version":"2.0",
      "template":{
        "outputs":[{"textCard":{
          "title":"성공적으로 예약되었습니다",
          "description":`- 방: ${room_type}\n- 예약번호: ${reserve_code}\n- 시간: ${displayTime}\n- 신청자: ${hiddenName}`
        }}]
      }
    });
  } catch(err){
    console.error("[ERROR] reserve:", err);
    return res.send({status:"FAIL", message:"예약 처리 중 오류"});
  }
}

/***********************************************
 * (B) 충전기 예약
 ***********************************************/
async function reserveCharger(reqBody, res, type){
  console.log("[INFO] reserveCharger->", type);
  try {
    const start_time_str = JSON.parse(reqBody.action.params.start_time).value; // "16:30"
    const end_time_str   = JSON.parse(reqBody.action.params.end_time).value;   // "18:30"
    const client_info    = parseClientInfo(reqBody.action.params.client_info);
    const kakao_id       = reqBody.userRequest.user.id;
    const displayTime    = `${start_time_str} - ${end_time_str}`;

    // 날짜
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    // TIME
    const start_db = `${start_time_str}:00`;
    const end_db   = `${end_time_str}:00`;

    // table='charger'
    const table='charger';

    // 납부자 여부
    if(await isNotPayer(client_info.name, client_info.id)){
      console.log("[WARN] Not a payer");
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{"textCard":{
            "title":"학생회비 납부자가 아닙니다",
            "description":`이름:${client_info.name}\n학번:${client_info.id}`
          }}]
        }
      });
    }

    if(!isAvailableTime()){
      console.log("[WARN] not available time-charger");
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{"textCard":{
            "title":"현재 예약할 수 없는 시간입니다",
            "description":"평일 9시~22시 당일만 가능"
          }}]
        }
      });
    }

    if(isWrongHours(start_time_str,end_time_str)){
      console.log("[WARN] Wrong hours-charger");
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{"textCard":{
            "title":"30분부터 최대4시간 가능",
            "description":`충전기:${type}\n시간:${displayTime}`
          }}]
        }
      });
    }

    // 중복 -> type + ' 1' or type + ' 2'
    // 예 "노트북 충전기 (C-Type 65W) 1"
    // 번갈아 예약
    if(await checkOverlap(table, dateStr, start_db, end_db, `${type} 1`)){
      console.log("[DEBUG] Overlap with type1-> check type2");
      if(await checkOverlap(table, dateStr, start_db, end_db, `${type} 2`)){
        console.log("[WARN] Both chargers overlapped");
        return res.send({
          "version":"2.0",
          "template":{
            "outputs":[{"textCard":{
              "title":"모든 충전기가 사용중입니다",
              "description":`충전기:${type}\n시간:${displayTime}`
            }}]
          }
        });
      } else {
        // "type2" 가능
        const code=await generateReserveCode('CHARGER');
        const hiddenName=hideMiddleChar(client_info.name);
        const locker_pwd=await getLockertPassword(`${type} 2`);
        // 응답
        await addToDatabaseCharger(table, code, `${type} 2`, dateStr, start_db, end_db, hiddenName, client_info, kakao_id);
        return res.send({ /* "성공적으로 대여","사물함 비번:"... */ });
      }
    }

    // "type1" 가능
    const code=await generateReserveCode('CHARGER');
    const hiddenName=hideMiddleChar(client_info.name);
    const locker_pwd=await getLockertPassword(`${type} 1`);
    await addToDatabaseCharger(table, code, `${type} 1`, dateStr, start_db, end_db, hiddenName, client_info, kakao_id);
    return res.send({ /* "성공적으로 대여" */ });

  } catch(err){
    console.error("[ERROR] reserveCharger:",err);
    return res.send({status:"FAIL",message:"충전기 예약 중 오류"});
  }
}

/***********************************************
 * (C) 예약 취소
 ***********************************************/
async function reserveCancel(reqBody, res) {
  console.log("[INFO] reserveCancel() called");
  try {
    const reserve_code = reqBody.action.params.reserve_code;
    const kakao_id = reqBody.userRequest.user.id;
    console.log("[DEBUG] code=", reserve_code, "kakao_id=", kakao_id);

    // logs
    const conn = await pool.getConnection();
    let logRow;
    try {
      const query = `SELECT * FROM logs WHERE reserve_code=? AND request_type='reserve'`;
      console.log("[DEBUG] cancel-check logs:", query);
      const [rows] = await conn.execute(query, [reserve_code]);
      if (!rows.length) {
        console.log("[FAILED] No matching code->", reserve_code);
        const d=`다시 시도해주세요.`;
        res.send({
          "version":"2.0",
          "template":{
            "outputs":[{"textCard":{
              "title":"예약번호와 일치하는 예약이 없습니다",
              "description":d,
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }}]
          }
        });
        return;
      }
      logRow=rows[0];
      if(logRow.kakao_id!==kakao_id){
        console.log("[FAILED] Another person's code->", reserve_code);
        const d=`신청자의 카카오톡 계정으로 취소해주세요.`;
        res.send({
          "version":"2.0",
          "template":{
            "outputs":[{"textCard":{
              "title":"신청자 본인이 아닙니다",
              "description":d,
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }}]
          }
        });
        return;
      }
    } finally { conn.release(); }

    // 어떤 테이블인지
    let table;
    const c = reserve_code[0];
    if(['1','2','3','4'].includes(c)) {
      table='new_media_library';
    } else if(['5','6'].includes(c)) {
      table='glab';
    } else if(['7'].includes(c)) {
      table='charger';
    } else {
      console.log("[FAILED] Unknown prefix->", c);
      const d=`다시 시도해주세요.`;
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{"textCard":{
            "title":"잘못된 예약코드입니다",
            "description":d,
            "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
          }}]
        }
      });
    }

    // 삭제
    const conn2 = await pool.getConnection();
    try {
      const checkQ = `SELECT * FROM ${table} WHERE reserve_code=?`;
      console.log("[DEBUG] check table row->", checkQ);
      const [checkRows] = await conn2.execute(checkQ, [reserve_code]);
      if(!checkRows.length) {
        console.log("[FAILED] Already canceled->", reserve_code);
        const d=`다시 시도해주세요.`;
        res.send({
          "version":"2.0",
          "template":{
            "outputs":[{"textCard":{
              "title":"이미 취소된 예약입니다",
              "description":d,
              "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
            }}]
          }
        });
        return;
      }
      const delQ = `DELETE FROM ${table} WHERE reserve_code=?`;
      console.log("[DEBUG] delete row->", delQ);
      await conn2.execute(delQ,[reserve_code]);

      const logQ = `
        INSERT INTO logs (reserve_code, room_type, request_type, name, student_id, phone, kakao_id)
        VALUES(?,?,?,?,?,?,?)
      `;
      console.log("[DEBUG] insert cancel log->", logQ);
      await conn2.execute(logQ,[
        logRow.reserve_code,
        logRow.room_type,
        'cancel',
        logRow.name,
        logRow.student_id,
        logRow.phone,
        logRow.kakao_id
      ]);

      const origin=checkRows[0];
      const st=origin.start_time.substring(11,16);
      const et=origin.end_time.substring(11,16);
      const time_string=`${st} - ${et}`;
      const hiddenName=origin.masked_name;
      const d=`- ${logRow.room_type}\n- 예약 번호: ${reserve_code}\n- 대여 시간: ${time_string}\n- 신청자: ${hiddenName}`;

      res.send({
        "version":"2.0",
        "template":{
          "outputs":[{"textCard":{
            "title":"대여를 취소했습니다",
            "description":d,
            "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
          }}]
        }
      });
      console.log("[SUCCESS] reserveCancel->", reserve_code);

    } finally { conn2.release(); }
  } catch(err){
    console.error("[ERROR] reserveCancel:", err);
    return res.send({ "status":"FAIL", "message":"예약 취소 중 오류" });
  }
}

/***********************************************
 * (D) 유효성 검사
 ***********************************************/
async function reserveStartTimeCheck(reqBody, res){
  console.log("[INFO] reserveStartTimeCheck");
  try {
    const st=reqBody.value.origin.slice(0,5);
    const now=new Date();
    const curMin=now.getHours()*60 + now.getMinutes();
    const [sh,sm]=st.split(':').map(Number);
    const startMin=sh*60+sm;
    const diff=startMin-curMin;
    if(diff<30 && diff<0) {
      console.log("[FAILED] Not available 30 min ago->", st);
      return res.send({ "status":"FAIL", "message":"30분 전 시간은 예약 불가" });
    }
    console.log("[SUCCESS] startTime->", st);
    res.send({ "status":"SUCCESS" });
  } catch(e){
    console.error("[ERROR] reserveStartTimeCheck:", e);
    res.send({ "status":"FAIL", "message":"잘못된 요청" });
  }
}
async function reserveClientInfoCheck(reqBody, res){
  console.log("[INFO] reserveClientInfoCheck");
  try {
    const str=reqBody.value.origin;
    const cleaned=str.replace(/[\s-]/g,'');
    const parts=cleaned.split(',');
    if(parts.length!==3){
      console.log("[FAILED] Invalid client info->", str);
      return res.send({ "status":"FAIL", "message":"이름,학번,전화번호" });
    }
    const [name,sid,pho]=parts;
    if(!/^\d{8}$/.test(sid)){
      console.log("[FAILED] Invalid studentID->", sid);
      return res.send({ "status":"FAIL", "message":"학번은 8자리" });
    }
    if(!/^\d{11}$/.test(pho)){
      console.log("[FAILED] Invalid phone->", pho);
      return res.send({ "status":"FAIL", "message":"전화번호는 11자리" });
    }
    if(!name||name.length<1){
      console.log("[FAILED] Invalid name->", name);
      return res.send({ "status":"FAIL", "message":"이름을 입력" });
    }
    console.log("[SUCCESS] clientInfo->", name,sid,pho);
    res.send({ "status":"SUCCESS" });
  } catch(e){
    console.error("[ERROR] reserveClientInfoCheck:", e);
    res.send({ "status":"FAIL", "message":"잘못된 요청" });
  }
}
async function reserveCodeCheck(reqBody, res){
  console.log("[INFO] reserveCodeCheck");
  try {
    const code=reqBody.value.origin;
    if(!/^\d{6}$/.test(code)){
      console.log("[FAILED] Invalid code->", code);
      return res.send({"status":"FAIL","message":"올바른 형식 아님"});
    }
    const conn=await pool.getConnection();
    try {
      const q=`SELECT * FROM logs WHERE reserve_code=?`;
      console.log("[DEBUG] logs code->", q);
      const [rows]=await conn.execute(q,[code]);
      if(!rows.length){
        console.log("[FAILED] code not found->", code);
        return res.send({"status":"FAIL","message":"존재하지 않는 예약코드"});
      }
      console.log("[SUCCESS] code->", code);
      res.send({"status":"SUCCESS"});
    } finally {
      conn.release();
    }
  } catch(e){
    console.error("[ERROR] reserveCodeCheck:", e);
    res.send({"status":"FAIL","message":"잘못된 요청"});
  }
}

/***********************************************
 * (E) 중복 체크 (당일만)
 ***********************************************/

async function checkOverlap(table, dateStr, startTime, endTime, itemType){
  console.log("[INFO] checkOverlap->", table, itemType);
  const conn=await pool.getConnection();
  try {
    // charger => charger_type, else => room_type
    let col = (table==='charger')? 'charger_type' : 'room_type';

    const q=`
      SELECT *
      FROM ${table}
      WHERE
        reserve_date = ?
        AND ${col} = ?
        AND start_time < ?
        AND end_time > ?
    `;
    console.log("[DEBUG] overlap query->", q);
    // 4개 bind
    const [rows]=await conn.execute(q, [dateStr, itemType, endTime, startTime]);
    console.log("[DEBUG] overlap count->", rows.length);
    return (rows.length>0);
  } catch(e){
    console.error("[ERROR] checkOverlap:", e);
    return false;
  } finally {
    conn.release();
  }
}



/***********************************************
 * (F) DB Insert
 ***********************************************/
async function addToDatabase(table, code, rtype, rDate, stime, etime, maskedName, client_info, kakao_id){
  console.log("[INFO] addToDatabase->", table, code);
  // debug
  console.log("In addToDatabase arguments:", [
    code, rtype, rDate, stime, etime, maskedName
  ]);

  const conn=await pool.getConnection();
  try {
    const q=`
      INSERT INTO ${table} (
        reserve_code, room_type, reserve_date,
        start_time, end_time, masked_name
      ) VALUES(?,?,?,?,?,?)
    `;
    // 6개 bind
    await conn.execute(q, [
      code,
      rtype,
      rDate,       // "YYYY-MM-DD"
      stime,       // "HH:MM:SS"
      etime,       // "HH:MM:SS"
      maskedName
    ]);

    // logs
    const logQ=`
      INSERT INTO logs (
        reserve_code, room_type, request_type,
        name, student_id, phone, kakao_id
      ) VALUES(?,?,?,?,?,?,?)
    `;
    await conn.execute(logQ, [
      code,
      rtype,
      'reserve',
      client_info.name,
      client_info.id,
      client_info.phone,
      kakao_id
    ]);
  } finally {
    conn.release();
  }
}

async function addToDatabaseCharger(table, code, ctype, rDate, stime, etime, masked, info, kakao_id){
  console.log("[INFO] addToDatabaseCharger->", ctype, code);
  // debug
  console.log("In addToDatabaseCharger arguments:", [
    code, ctype, rDate, stime, etime, masked
  ]);

  const conn=await pool.getConnection();
  try {
    const q=`
      INSERT INTO ${table} (
        reserve_code, charger_type, reserve_date,
        start_time, end_time, masked_name
      ) VALUES(?,?,?,?,?,?)
    `;
    await conn.execute(q, [
      code,
      ctype,
      rDate,
      stime,
      etime,
      masked
    ]);

    // logs
    const logQ=`
      INSERT INTO logs (
        reserve_code, room_type, request_type,
        name, student_id, phone, kakao_id
      ) VALUES(?,?,?,?,?,?,?)
    `;
    await conn.execute(logQ, [
      code,
      ctype,
      'reserve',
      info.name,
      info.id,
      info.phone,
      kakao_id
    ]);
  } finally {
    conn.release();
  }
}




/***********************************************
 * (G) 코드 생성: 가장 최근 코드 +1
 ***********************************************/
async function generateReserveCode(rtype){
  console.log("[INFO] generateReserveCode->", rtype);
  const room_codes={
    '01BLUE':'1','02GRAY':'2','03SILVER':'3','04GOLD':'4','GLAB1':'5','GLAB2':'6'
  };
  const prefix=(rtype==='CHARGER')?'7':(room_codes[rtype]||'9');

  const conn=await pool.getConnection();
  try{
    // reserve_code 중 prefix로 시작하는 것 중,
    // SUBSTRING(reserve_code,2) => 앞 한 글자(prefix) 뺀 부분 -> 숫자로 변환 -> 가장 큰 값 찾기
    const q=`
      SELECT MAX(CAST(SUBSTRING(reserve_code,2) AS UNSIGNED)) AS max_id
      FROM logs
      WHERE reserve_code LIKE '${prefix}%'
        AND request_type='reserve'
    `;
    console.log("[DEBUG] code gen->", q);
    const [rows] = await conn.execute(q);
    let maxID = rows[0].max_id; // ex) 00001 -> 1
    if(!maxID) maxID=0;        // logs가 비었으면 null => 0

    const newID = maxID+1;
    const code = prefix + String(newID).padStart(5,'0'); // 6자리
    console.log("[INFO] new code->", code);
    return code;

  } catch(e){
    console.error("[ERROR] generateReserveCode:", e);
    return prefix + '99999';
  } finally {
    conn.release();
  }
}

/***********************************************
 * (H) 납부자/비밀번호
 ***********************************************/
async function isNotPayer(name, id){
  console.log("[INFO] isNotPayer->", name,id);
  const conn=await pool.getConnection();
  try{
    const q=`SELECT * FROM payers WHERE student_id=? AND name=?`;
    console.log("[DEBUG] payers->", q);
    const [rows]=await conn.execute(q,[id,name]);
    console.log("[DEBUG] payers found->", rows.length);
    return rows.length===0;
  } catch(e){
    console.error("[ERROR] isNotPayer:", e);
    return true;
  } finally {
    conn.release();
  }
}
async function getLockertPassword(ctype){
  console.log("[INFO] getLockertPassword->", ctype);
  const conn=await pool.getConnection();
  try{
    const q=`SELECT password FROM charger_lockers WHERE charger_type=?`;
    console.log("[DEBUG] locker query->", q);
    const [rows]=await conn.execute(q,[ctype]);
    if(!rows.length){
      console.log("[WARN] No locker found->", ctype);
      return '0000';
    }
    return rows[0].password;
  } catch(e){
    console.error("[ERROR] getLockertPassword:", e);
    return '0000';
  } finally {
    conn.release();
  }
}

/***********************************************
 * 서버 실행
 ***********************************************/
const port = process.env.PORT || 8000;
app.listen(port, ()=>{
  console.log(`Server running on port ${port}`);
});
