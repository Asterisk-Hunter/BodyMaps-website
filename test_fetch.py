import requests
import json

url = 'http://localhost:5001/api/interactive-segment/5c50134f-b1c9-44a7-b6fe-e73eef74f3f3'
headers = {
    'Origin': 'http://localhost:5173',
    'Content-Type': 'application/json'
}
payload = {
    'point_lps': [0, 0, 0],
    'target_segment': 1,
    'res': 'low'
}

print(f'POST {url}')
try:
    r = requests.post(url, headers=headers, json=payload, timeout=5)
    print('Status:', r.status_code)
    print('Headers:', dict(r.headers))
    print('Body:', r.text)
except Exception as e:
    print('Exception:', e)
