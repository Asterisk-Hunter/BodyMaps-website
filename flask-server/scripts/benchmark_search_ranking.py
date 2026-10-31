"""Repeatable synthetic catalog benchmark; never reads patient data or mounts."""
import json
from pathlib import Path
import statistics
import sys
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import pandas as pd
from services.search_ranking import rank_quality_results,rank_legacy_quality_results


def frame(n=43600):
    return pd.DataFrame([dict(__case_str=f'synthetic_{i:05d}',__case_sortkey=i,
        __dataset=('PanTS','AbdomenAtlas','CancerVerse')[(i//1000)%3],
        __tumor01=(i//100)%2,__thumbnail_quality_rank=0,__ct_bytes=100000-i,
        __voxel_count=100000-i,__spacing_volume=.5+i/1e6,__shape_sum=1000-i/1000,
        __sex='F',__age=50) for i in range(n)])


def main():
    df=frame();result={"rows":len(df),"fixture":"synthetic metadata only","runs":3}
    for name,rank in [('before',rank_legacy_quality_results),('after',rank_quality_results)]:
        seconds=[]
        for _ in range(3):
            start=time.perf_counter();out=rank(df);seconds.append(time.perf_counter()-start)
        result[name]={"seconds":seconds,"median_seconds":statistics.median(seconds),
                      "first12":out.iloc[:12][['__case_str','__dataset','__tumor01']].to_dict('records')}
    print(json.dumps(result,indent=2))


if __name__=='__main__':main()
