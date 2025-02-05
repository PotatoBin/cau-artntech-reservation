require("dotenv").config();
const express = require('express');
const app = express();
const router = express.Router();
const mysql = require('mysql2/promise');
const morgan = require('morgan');

// Morgan 설정 (서버가 KST면 new Date() 자체가 한국시각)
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

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(morgan('combined-kst'));
app.use('/reserve', router);

// 라우트
router.post('/01BLUE', async (req, res) => await reserve(req.body, res, '01BLUE'));
router.post('/02GRAY', async (req, res) => await reserve(req.body, res, '02GRAY'));
router.post('/03SILVER', async (req, res) => await reserve(req.body, res, '03SILVER'));
router.post('/04GOLD', async (req, res) => await reserve(req.body, res, '04GOLD'));
router.post('/GLAB1', async (req, res) => await reserve(req.body, res, 'GLAB1'));
router.post('/GLAB2', async (req, res) => await reserve(req.body, res, 'GLAB2'));

router.post('/CHARGER01', async (req, res) => await reserveCharger(req.body, res, '노트북 충전기 (C-Type 65W)'));
router.post('/CHARGER02', async (req, res) => await reserveCharger(req.body, res, '스마트폰 충전기 (C-Type)'));
router.post('/CHARGER03', async (req, res) => await reserveCharger(req.body, res, '아이폰 충전기 (8pin)'));

router.post('/check/start_time', async (req, res) => await reserveStartTimeCheck(req.body, res));
router.post('/check/client_info', async (req, res) => await reserveClientInfoCheck(req.body, res));
router.post('/check/reserve_code', async (req, res) => await reserveCodeCheck(req.body, res));
router.post('/cancel', async (req, res) => await reserveCancel(req.body, res));

router.head('/wakeup', async (req, res) => {
  console.log("[INFO] wakeup called");
  res.status(200).send();
});

function getNow() { // 서버가 KST라면 new Date()가 한국시각
  return new Date();
}
function isAvailableTime() {
  const now = getNow(), h = now.getHours(), d = now.getDay();
  if (d === 0 || d === 6) return false;
  if (h < 9 || h >= 22) return false;
  return true;
}
function parseClientInfo(str) {
  const parts = str.replace(/[\s-]/g, '').split(',');
  return { name: parts[0], id: parts[1], phone: parts[2] };
}
function hideMiddleChar(str) {
  if (str.length < 3) return str[0] + '*';
  return str[0] + '*'.repeat(str.length - 2) + str[str.length - 1];
}
function isWrongHours(s,e) {
  const [sh, sm] = s.split(':').map(Number);
  const [eh, em] = e.split(':').map(Number);
  const diff = (eh*60+em) - (sh*60+sm);
  return diff < 30 || diff > 240;
}

async function checkOverlap(table, start_time, end_time, rtype) {
  console.log(`[INFO] Checking overlap for ${rtype}, table=${table}`);
  const conn = await pool.getConnection();
  try {
    const sql = `
      SELECT * FROM ${table}
      WHERE (room_type=? OR charger_type=?)
        AND DATE(created_at)=CURDATE()
        AND (
          (start_time<=? AND end_time>?)
          OR
          (start_time<? AND end_time>=?)
          OR
          (start_time>=? AND end_time<=?)
        )
    `;
    const [rows] = await conn.execute(sql, [rtype, rtype, start_time, start_time, end_time, end_time, start_time, end_time]);
    return rows.length > 0;
  } finally {
    conn.release();
  }
}

// (A) 방/공간 예약
async function reserve(body, res, room_type) {
  try {
    console.log("[INFO] reserve:", room_type);
    const st = JSON.parse(body.action.params.start_time).value; 
    const et = JSON.parse(body.action.params.end_time).value; 
    const cinfo = parseClientInfo(body.action.params.client_info);
    const kakao_id = body.userRequest.user.id;
    const nowDate = getNow().toISOString().split('T')[0];
    const stDB = `${nowDate} ${st}:00`; 
    const etDB = `${nowDate} ${et}:00`;
    const timeStr = `${st} - ${et}`;
    let table;
    if (['01BLUE','02GRAY','03SILVER','04GOLD'].includes(room_type)) table='new_media_library';
    else if(['GLAB1','GLAB2'].includes(room_type)) table='glab';
    else return res.send({ status:"FAIL", message:"잘못된 방 유형" });

    if (!isAvailableTime()) {
      return res.send({
        "version":"2.0","template":{"outputs":[{"textCard":{
          "title":"현재 예약할 수 없는 시간입니다.",
          "description":"평일 9시부터 22시까지 당일 예약만 가능합니다.",
          "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
        }}]}
      });
    }
    if (isWrongHours(st, et)) {
      return res.send({
        "version":"2.0","template":{"outputs":[{"textCard":{
          "title":"30분부터 최대 4시간까지 신청 가능합니다.",
          "description":`- 방 종류: ${room_type}\n- 신청 시간: ${timeStr}\n\n다시 시도해주세요.`,
          "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
        }}]}
      });
    }
    if (await checkOverlap(table, stDB, etDB, room_type)) {
      return res.send({
        "version":"2.0","template":{"outputs":[{"textCard":{
          "title":"해당 일시에 겹치는 예약이 있습니다.",
          "description":`- 방 종류: ${room_type}\n- 신청 시간: ${timeStr}\n\n비어있는 시간에 다시 신청해주세요.`,
          "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
        }}]}
      });
    }

    const code = await generateReserveCode(room_type);
    const hidden = hideMiddleChar(cinfo.name);
    await addToDatabase(table, code, room_type, stDB, etDB, hidden, cinfo, kakao_id);
    return res.send({
      "version":"2.0","template":{"outputs":[{"textCard":{
        "title":"성공적으로 예약되었습니다.",
        "description":`- 방 종류: ${room_type}\n- 예약 번호: ${code}\n- 대여 시간: ${timeStr}\n- 신청자: ${hidden}`,
        "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
      }}]}
    });
  } catch(e){
    console.log("[ERR] reserve:", e);
    return res.send({status:"FAIL", message:"오류 발생"});
  }
}

// (B) 충전기 예약
async function reserveCharger(body, res, type) {
  try {
    console.log("[INFO] reserveCharger:", type);
    const st = JSON.parse(body.action.params.start_time).value;
    const et = JSON.parse(body.action.params.end_time).value;
    const cinfo = parseClientInfo(body.action.params.client_info);
    const kakao_id = body.userRequest.user.id;
    const timeStr = `${st.slice(0,5)} - ${et.slice(0,5)}`;
    const nowDate = getNow().toISOString().split('T')[0];
    const stDB = `${nowDate} ${st}:00`;
    const etDB = `${nowDate} ${et}:00`;
    const table='charger';

    if (await isNotPayer(cinfo.name, cinfo.id)) {
      return res.send({
        "version":"2.0","template":{"outputs":[{"textCard":{
          "title":"학생회비 납부자가 아닙니다.",
          "description":`- 이름:${cinfo.name}\n- 학번:${cinfo.id}\n학생회비 납부자가 아닙니다.`,
          "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
        }}]}
      });
    }
    if (!isAvailableTime()) {
      return res.send({
        "version":"2.0","template":{"outputs":[{"textCard":{
          "title":"현재 예약할 수 없는 시간입니다.",
          "description":"평일 9시~22시만 당일 예약 가능",
          "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
        }}]}
      });
    }
    if (isWrongHours(st, et)) {
      return res.send({
        "version":"2.0","template":{"outputs":[{"textCard":{
          "title":"30분부터 최대 4시간까지 신청 가능합니다.",
          "description":`- 충전기:${type}\n- 신청 시간:${timeStr}`,
          "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
        }}]}
      });
    }
    if (await checkOverlap(table, stDB, etDB, `${type} 1`)) {
      if (await checkOverlap(table, stDB, etDB, `${type} 2`)) {
        return res.send({
          "version":"2.0","template":{"outputs":[{"textCard":{
            "title":"모든 충전기가 사용중입니다.",
            "description":`- 충전기:${type}\n- 시간:${timeStr}`,
            "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
          }}]}
        });
      } else {
        const code=await generateReserveCode('CHARGER');
        const hidden=hideMiddleChar(cinfo.name);
        const pass=await getLockertPassword(`${type} 2`);
        await addToChargerDB(table, code, `${type} 2`, stDB, etDB, hidden, cinfo, kakao_id);
        return res.send({
          "version":"2.0","template":{"outputs":[{"textCard":{
            "title":"성공적으로 대여하였습니다.",
            "description":`- 충전기:${type} 2\n- 사물함 비밀번호:${pass}\n- 예약 번호:${code}\n- 대여 시간:${timeStr}\n- 신청자:${hidden}`,
            "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
          }}]}
        });
      }
    }
    // type1 가능
    const code=await generateReserveCode('CHARGER');
    const hidden=hideMiddleChar(cinfo.name);
    const pass=await getLockertPassword(`${type} 1`);
    await addToChargerDB(table, code, `${type} 1`, stDB, etDB, hidden, cinfo, kakao_id);
    return res.send({
      "version":"2.0","template":{"outputs":[{"textCard":{
        "title":"성공적으로 대여하였습니다.",
        "description":`- 충전기:${type} 1\n- 사물함 비밀번호:${pass}\n- 예약 번호:${code}\n- 대여 시간:${timeStr}\n- 신청자:${hidden}`,
        "buttons":[{"label":"처음으로","action":"block","messageText":"처럼으로"}]
      }}]}
    });
  } catch(e){
    console.log("[ERR] reserveCharger:", e);
    return res.send({status:"FAIL", message:"오류 발생"});
  }
}
async function addToChargerDB(tbl, code, ctype, st, et, masked, info, kid) {
  const conn=await pool.getConnection();
  try {
    const sql=`INSERT INTO ${tbl} (reserve_code, charger_type, start_time, end_time, masked_name) VALUES (?,?,?,?,?)`;
    await conn.execute(sql, [code, ctype, st, et, masked]);
    const log=`INSERT INTO logs (reserve_code,room_type,request_type,name,student_id,phone,kakao_id) 
               VALUES (?,?, 'reserve', ?,?,?,?)`;
    await conn.execute(log, [code, ctype, info.name, info.id, info.phone, kid]);
  } finally {
    conn.release();
  }
}

// (C) 예약 취소
async function reserveCancel(body, res){
  try {
    console.log("[INFO] reserveCancel");
    const code = body.action.params.reserve_code;
    const kid  = body.userRequest.user.id;
    const c = await pool.getConnection();
    let row;
    try {
      const q = `SELECT * FROM logs WHERE reserve_code=? AND request_type='reserve'`;
      const [rows] = await c.execute(q,[code]);
      if(!rows.length){
        return res.send({
          "version":"2.0","template":{"outputs":[{"textCard":{
            "title":"예약번호와 일치하는 예약이 없습니다",
            "description":"다시 시도해주세요.",
            "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
          }}]}
        });
      }
      row=rows[0];
      if(row.kakao_id!==kid){
        return res.send({
          "version":"2.0","template":{"outputs":[{"textCard":{
            "title":"신청자 본인이 아닙니다",
            "description":"신청자의 카카오톡 계정으로 취소해주세요.",
            "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
          }}]}
        });
      }
    } finally { c.release(); }

    let tbl;
    const first=code[0];
    if(['1','2','3','4'].includes(first)) tbl='new_media_library';
    else if(['5','6'].includes(first)) tbl='glab';
    else if(first==='7') tbl='charger'; 
    else {
      return res.send({
        "version":"2.0","template":{"outputs":[{"textCard":{
          "title":"잘못된 예약코드입니다",
          "description":"다시 시도해주세요.",
          "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
        }}]}
      });
    }
    const conn2=await pool.getConnection();
    try {
      const cq=`SELECT * FROM ${tbl} WHERE reserve_code=?`;
      const [crow]=await conn2.execute(cq,[code]);
      if(!crow.length){
        return res.send({
          "version":"2.0","template":{"outputs":[{"textCard":{
            "title":"이미 취소된 예약입니다",
            "description":"다시 시도해주세요.",
            "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
          }}]}
        });
      }
      await conn2.execute(`DELETE FROM ${tbl} WHERE reserve_code=?`,[code]);
      await conn2.execute(`
        INSERT INTO logs (reserve_code, room_type, request_type, name, student_id, phone, kakao_id)
        VALUES (?,?, 'cancel', ?,?,?,?)`, 
        [row.reserve_code, row.room_type, row.name, row.student_id, row.phone, row.kakao_id]
      );
      const origin=crow[0];
      const tstr = origin.start_time.substring(11,16)+' - '+origin.end_time.substring(11,16);
      const hidden = origin.masked_name;
      return res.send({
        "version":"2.0","template":{"outputs":[{"textCard":{
          "title":"대여를 취소했습니다",
          "description":`- ${row.room_type}\n- 예약 번호:${code}\n- 대여 시간:${tstr}\n- 신청자:${hidden}`,
          "buttons":[{"label":"처음으로","action":"block","messageText":"처음으로"}]
        }}]}
      });
    } finally { conn2.release(); }
  } catch(e){
    console.log("[ERR] reserveCancel:", e);
    return res.send({status:"FAIL", message:"오류 발생"});
  }
}

// (D) 유효성 체크
async function reserveStartTimeCheck(body, res){
  try {
    const str=body.value.origin.slice(0,5);
    const now = getNow();
    const stH= parseInt(str.split(':')[0],10);
    const stM= parseInt(str.split(':')[1],10);
    const diff = (stH*60+stM) - (now.getHours()*60+ now.getMinutes());
    if(diff < 30) return res.send({status:"FAIL", message:"30분 전 시간은 예약불가"});
    return res.send({status:"SUCCESS"});
  } catch(e){return res.send({status:"FAIL"});}
}
async function reserveClientInfoCheck(body, res){
  try {
    const val= body.value.origin.replace(/[\s-]/g,'').split(',');
    if(val.length!==3) return res.send({status:"FAIL", message:"이름,학번,전화번호"});
    if(!/^\d{8}$/.test(val[1])) return res.send({status:"FAIL", message:"학번8자리"});
    if(!/^\d{11}$/.test(val[2])) return res.send({status:"FAIL", message:"전화번호11자리"});
    return res.send({status:"SUCCESS"});
  } catch(e){return res.send({status:"FAIL"});}
}
async function reserveCodeCheck(body, res){
  try {
    const code= body.value.origin;
    if(!/^\d{6}$/.test(code)) return res.send({status:"FAIL", message:"6자리"});
    const c= await pool.getConnection();
    try {
      const [r]= await c.execute(`SELECT * FROM logs WHERE reserve_code=?`,[code]);
      if(!r.length) return res.send({status:"FAIL", message:"존재x"});
      return res.send({status:"SUCCESS"});
    }finally{c.release();}
  } catch(e){return res.send({status:"FAIL"});}
}

// (E) DB
async function addToDatabase(table, code, rtype, st, et, masked, info, kid) {
  const conn=await pool.getConnection();
  try {
    await conn.execute(`INSERT INTO ${table} (reserve_code, room_type, start_time, end_time, masked_name) VALUES (?,?,?,?,?)`,
      [code, rtype, st, et, masked]);
    await conn.execute(`
      INSERT INTO logs (reserve_code, room_type, request_type, name, student_id, phone, kakao_id) 
      VALUES (?,?, 'reserve', ?,?,?,?)`,
      [code, rtype, info.name, info.id, info.phone, kid]);
  } finally {
    conn.release();
  }
}
async function isNotPayer(name, id){
  const conn=await pool.getConnection();
  try {
    const [r]=await conn.execute(`SELECT * FROM payers WHERE student_id=? AND name=?`,[id,name]);
    return r.length===0;
  } finally { conn.release();}
}
async function getLockertPassword(type){
  const c=await pool.getConnection();
  try {
    const [r]=await c.execute(`SELECT password FROM charger_lockers WHERE charger_type=?`,[type]);
    return r.length?r[0].password:'0000';
  } finally { c.release();}
}
async function generateReserveCode(rtype){
  const conn=await pool.getConnection();
  let prefix='9';
  const map = { '01BLUE':'1','02GRAY':'2','03SILVER':'3','04GOLD':'4','GLAB1':'5','GLAB2':'6','CHARGER':'7' };
  if(map[rtype]) prefix= map[rtype];
  try {
    const [rows] = await conn.execute(
      `SELECT COUNT(*) AS cnt FROM logs WHERE room_type LIKE ? AND request_type='reserve'`,
      [`${prefix}%`]
    );
    const n= rows[0].cnt+1;
    return prefix + String(n).padStart(5,'0');
  } finally { conn.release();}
}

const port= process.env.PORT||8000;
app.listen(port, ()=> console.log(`Server on port ${port}`));
