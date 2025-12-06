import fetch from 'node-fetch';

async function testPhotonCharge() {
  const accessKey = process.env.DEV_ACCESS_KEY;   // set in env
  const clientName = process.env.CLIENT_NAME;     // set in env
  const skuId = Number(process.env.SKU_ID);       // set in env
  const eventValue = 1; // charge 1 photon for test

  const url = 'https://openapi.dp.tech/openapi/v1/api/integral/consume';

  const timestamp = Math.floor(Date.now() / 1000);
  const rand = Math.floor(Math.random() * 9000) + 1000;
  const bizNo = Number(`${timestamp}${rand}`);

  const headers = {
    'accessKey': accessKey,
    'x-app-key': clientName,
    'Content-Type': 'application/json',
  };

  const payload = {
    bizNo,
    changeType: 1,
    eventValue,
    skuId,
    scene: 'appCustomizeCharge',
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log('Status:', res.status);
  console.log('Body:', text);
}

testPhotonCharge().catch(console.error);