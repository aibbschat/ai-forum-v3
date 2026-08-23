import json, sys
proc = sys.argv[1]
try:
    d = json.load(sys.stdin)
    p = next((x for x in d if x.get("name") == proc), None)
    print(p["pm2_env"]["status"] + "/" + str(p["pm2_env"]["restart_time"]) + "restarts" if p else "NOT_FOUND")
except Exception:
    print("PARSE_ERR")
