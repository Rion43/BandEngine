import sqlite3, sys, plistlib
conn = sqlite3.connect(sys.argv[1])
cur = conn.cursor()
cur.execute("SELECT inline_data FROM manifest WHERE inline_data IS NOT NULL LIMIT 1")
row = cur.fetchone()
blob = row[0]
plist = plistlib.loads(blob)
objects = plist['$objects']
top = plist['$top']
root_ref = top['root']['$UID']
root_obj = objects[root_ref]
print(f'Root object ({root_ref}): {type(root_obj).__name__}')
if isinstance(root_obj, dict):
    for k, v in root_obj.items():
        if isinstance(v, dict) and '$UID' in v:
            ref = v['$UID']
            val = objects[ref]
            if isinstance(val, bytes):
                print(f'  {k}: Data({len(val)}B) = {val.hex()}')
            else:
                print(f'  {k}: {repr(val)}')
        else:
            print(f'  {k}: {repr(v)}')
    print()
    print('All $objects with 16-byte data:')
    for i, obj in enumerate(objects):
        if isinstance(obj, bytes) and len(obj) == 16:
            print(f'  objects[{i}]: {obj.hex()}')
conn.close()
