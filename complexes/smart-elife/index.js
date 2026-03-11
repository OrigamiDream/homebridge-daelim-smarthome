const fs = require("fs");

const BASE_URL = "https://smartelife.apt.co.kr";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/120.0.0.0 " +
    "Mobile Safari/537.36 " +
    "DAELIM/ANDROID";

async function fetchJson(url, options = {}, retries = 3) {
    const timeoutMs = 20000;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
            }
            return await res.json();
        } catch (err) {
            clearTimeout(timer);
            if (attempt >= retries) throw err;
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
    }
}

function mapComplex(raw) {
    return {
        apartmentCode: raw["apt_cd"] ?? null,
        apartmentName: raw["apt_nm"] ?? null,
        apartmentGroup: raw["apt_grp"] ?? null,

        provinceCode: raw["sd_cd"] ?? null,
        cityCountyCode: raw["sgg_cd"] ?? null,

        complexKey: raw["dj_ck"] ?? null,
        complexName: raw["dj_nm"] ?? null,
        complexAccessKey: raw["dj_acc_dt"] ?? null,
        complexCode: raw["dj_cd"] ?? null,
        complexDisplayName: raw["danji_nm"] ?? null,

        addressLine1: raw["dj_addr1"] ?? null,
        addressLine2: raw["da_addr2"] ?? null,
        homepageUrl: raw["dj_hp_uri"] ?? null,

        buildingCode: raw["dg_cd"] ?? null,
        buildingName: raw["dg_nm"] ?? null,
        buildingTypeCode: raw["dg_type_cd"] ?? null,
        buildingHouseCount: raw["dg_house_num"] ?? null,
        maxFloor: raw["max_floor_num"] ?? null,
        maxLine: raw["max_line_num"] ?? null,

        homeCode: raw["hm_cd"] ?? null,
        homeNumber: raw["hm_num"] ?? null,
        memberUid: raw["memb_uid"] ?? null,
        siteCode: raw["site_code"] ?? null,

        dong: raw["dong"] ?? null,
        ho: raw["ho"] ?? null,
        hoName: raw["ho_nm"] ?? null,

        builder: raw["builder"] ?? null,
        minAppVersion: raw["use_app_ver"] ?? null,
        openFlag: raw["open_yn"] ?? null,
        useFlag: raw["use_yn"] ?? null,

        startDate: raw["st_ymd"] ?? null,
        endDate: raw["ed_ymd"] ?? null,
        otherDate: raw["et_ymd"] ?? null,

        regDate: raw["reg_date"] ?? null,
        regUid: raw["reg_uid"] ?? null,
        regIp: raw["reg_ip"] ?? null,
        updDate: raw["upd_date"] ?? null,
        updUid: raw["upd_uid"] ?? null,
        updIp: raw["upd_ip"] ?? null,
        tokenRegDate: raw["tk_reg_date"] ?? null,
        dongs: [],
    };
}

function extractList(data, preferredKeys = []) {
    if (!data || !Array.isArray(data.data)) return [];
    const list = data.data;
    if (list.length === 0) return [];
    if (typeof list[0] === "object") {
        const out = [];
        for (const row of list) {
            for (const key of preferredKeys) {
                if (row && row[key]) {
                    out.push(String(row[key]));
                    break;
                }
            }
        }
        return out.filter(Boolean);
    }
    return list.map((v) => String(v));
}

async function fetchDongs(csrf, danjiKey) {
    const resp = await fetchJson(`${BASE_URL}/login/selectDong.ajax`, {
        method: "POST",
        headers: {
            "User-Agent": UA,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "_csrf": csrf,
        },
        body: JSON.stringify({ "dj_ck": danjiKey }),
    });
    return extractList(resp, ["dg_nm", "dong"]);
}

async function fetchHos(csrf, danjiKey, dong) {
    const resp = await fetchJson(`${BASE_URL}/login/selectHo.ajax`, {
        method: "POST",
        headers: {
            "User-Agent": UA,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "_csrf": csrf,
        },
        body: JSON.stringify({ "dj_ck": danjiKey, "select_dong": dong }),
    });
    return extractList(resp, ["ho_nm", "ho"]);
}

async function main() {
    const tokenResp = await fetchJson(`${BASE_URL}/common/nativeToken.ajax`, {
        method: "POST",
        headers: { "User-Agent": UA, Accept: "application/json" },
    });
    const csrf = tokenResp.value;
    if (!csrf) throw new Error("No csrf token in response");

    const danjiResp = await fetchJson(`${BASE_URL}/login/selectDanji.ajax`, {
        method: "POST",
        headers: {
            "User-Agent": UA,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "_csrf": csrf,
        },
        body: JSON.stringify({ "danji": "" }),
    });

    const rawList = Array.isArray(danjiResp.data) ? danjiResp.data : [];
    const mapped = rawList.map(mapComplex);

    const concurrency = 10;
    let cursor = 0;

    async function worker() {
        while (cursor < mapped.length) {
            const index = cursor++;
            const complex = mapped[index];
            const danjiKey = complex.complexKey || complex.complexCode || complex.apartmentCode;
            if (!danjiKey) continue;

            console.log(`Updating ${complex.complexDisplayName}...`);

            const dongs = await fetchDongs(csrf, danjiKey);
            const hoTasks = dongs.map(async (dong) => {
                const hos = await fetchHos(csrf, danjiKey, dong);
                return { dong, hos };
            });
            complex.dongs = await Promise.all(hoTasks);
        }
    }

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);

    fs.writeFileSync("./complexes/smart-elife/complexes.json", JSON.stringify(mapped, null, 2), "utf-8");
    console.log(`Wrote ${mapped.length} complexes to complexes.json`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
