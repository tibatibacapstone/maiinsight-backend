import os
import json
import pandas as pd
import numpy as np

from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sklearn.preprocessing import StandardScaler
from sklearn.cluster import KMeans

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    raise ValueError("DATABASE_URL is not found in .env")

DATABASE_URL = DATABASE_URL.replace("mysql://", "mysql+pymysql://")

engine = create_engine(DATABASE_URL)


def assign_playtime_segment(row):
    ratio_values = {
        "Morning Player": row["avg_ratio_pagi"],
        "Afternoon Player": row["avg_ratio_siang"],
        "Night Player": row["avg_ratio_malam"],
    }

    return max(ratio_values, key=ratio_values.get)


def assign_activity_level(total_sesi, q75, q95):
    if total_sesi <= q75:
        return "Low Activity"
    elif total_sesi <= q95:
        return "Medium Activity"
    else:
        return "High Activity"


def main():
    query = """
        SELECT
            id,
            nama,
            tanggalMain,
            jamMain,
            startHour,
            playTimeGroup,
            hargaBersih,
            status,
            period
        FROM facility_transactions
        WHERE LOWER(COALESCE(status, '')) = 'payment completed'
          AND playTimeGroup IN ('Pagi', 'Siang', 'Malam')
          AND nama IS NOT NULL
    """

    df = pd.read_sql(query, engine)

    if df.empty:
        raise ValueError("No valid facility transaction data found.")

    df["tanggalMain"] = pd.to_datetime(df["tanggalMain"], errors="coerce")
    df = df.dropna(subset=["tanggalMain", "startHour", "playTimeGroup", "nama"])

    # Operational insight 1: jumlah sesi pagi/siang/malam
    session_by_time = (
        df["playTimeGroup"]
        .value_counts()
        .reset_index()
    )
    session_by_time.columns = ["play_time_group", "session_count"]
    session_by_time_json = session_by_time.to_dict(orient="records")

    # Operational insight 2: heatmap hari x jam
    df["day_name"] = df["tanggalMain"].dt.day_name()

    day_mapping = {
        "Monday": "Mon",
        "Tuesday": "Tue",
        "Wednesday": "Wed",
        "Thursday": "Thu",
        "Friday": "Fri",
        "Saturday": "Sat",
        "Sunday": "Sun",
    }

    df["day_short"] = df["day_name"].map(day_mapping)

    heatmap_data = (
        df.groupby(["day_short", "startHour"])
        .size()
        .reset_index(name="session_count")
    )
    heatmap_json = heatmap_data.to_dict(orient="records")

    # Operational insight 3: top busy hour
    top_hour_data = (
        df.groupby("startHour")
        .size()
        .reset_index(name="session_count")
        .sort_values("session_count", ascending=False)
    )
    top_hour_json = top_hour_data.to_dict(orient="records")

    # Customer behavior feature engineering
    customer_time_features = (
        df.pivot_table(
            index="nama",
            columns="playTimeGroup",
            values="id",
            aggfunc="count",
            fill_value=0,
        )
        .reset_index()
    )

    customer_time_features.columns.name = None

    for col in ["Pagi", "Siang", "Malam"]:
        if col not in customer_time_features.columns:
            customer_time_features[col] = 0

    customer_time_features = customer_time_features.rename(
        columns={
            "Pagi": "sesi_pagi",
            "Siang": "sesi_siang",
            "Malam": "sesi_malam",
        }
    )

    customer_time_features["total_sesi"] = (
        customer_time_features["sesi_pagi"]
        + customer_time_features["sesi_siang"]
        + customer_time_features["sesi_malam"]
    )

    customer_time_features = customer_time_features[
        customer_time_features["total_sesi"] > 0
    ].copy()

    # Ratio dipakai untuk K-Means agar tidak berat ke outlier
    customer_time_features["ratio_pagi"] = (
        customer_time_features["sesi_pagi"] / customer_time_features["total_sesi"]
    )
    customer_time_features["ratio_siang"] = (
        customer_time_features["sesi_siang"] / customer_time_features["total_sesi"]
    )
    customer_time_features["ratio_malam"] = (
        customer_time_features["sesi_malam"] / customer_time_features["total_sesi"]
    )

    ml_features = customer_time_features[
        ["ratio_pagi", "ratio_siang", "ratio_malam"]
    ].copy()

    scaler = StandardScaler()
    scaled_features = scaler.fit_transform(ml_features)

    best_k = 3

    kmeans = KMeans(n_clusters=best_k, random_state=42, n_init=10)
    customer_time_features["playtime_cluster"] = kmeans.fit_predict(scaled_features)

    cluster_summary = customer_time_features.groupby("playtime_cluster").agg(
        total_customers=("nama", "count"),
        avg_sesi_pagi=("sesi_pagi", "mean"),
        avg_sesi_siang=("sesi_siang", "mean"),
        avg_sesi_malam=("sesi_malam", "mean"),
        avg_total_sesi=("total_sesi", "mean"),
        avg_ratio_pagi=("ratio_pagi", "mean"),
        avg_ratio_siang=("ratio_siang", "mean"),
        avg_ratio_malam=("ratio_malam", "mean"),
    ).reset_index()

    cluster_summary["playtime_segment"] = cluster_summary.apply(
        assign_playtime_segment,
        axis=1,
    )

    customer_time_features = customer_time_features.merge(
        cluster_summary[["playtime_cluster", "playtime_segment"]],
        on="playtime_cluster",
        how="left",
    )

    q75 = customer_time_features["total_sesi"].quantile(0.75)
    q95 = customer_time_features["total_sesi"].quantile(0.95)

    customer_time_features["activity_level"] = customer_time_features["total_sesi"].apply(
        lambda value: assign_activity_level(value, q75, q95)
    )

    with engine.begin() as conn:
        run_result = conn.execute(
            text("""
                INSERT INTO playtime_ml_runs (
                    period,
                    algorithm,
                    clusterCount,
                    totalCustomers,
                    totalSessions,
                    status,
                    sessionByTime,
                    heatmapData,
                    topHourData,
                    createdAt
                )
                VALUES (
                    :period,
                    :algorithm,
                    :clusterCount,
                    :totalCustomers,
                    :totalSessions,
                    :status,
                    :sessionByTime,
                    :heatmapData,
                    :topHourData,
                    NOW()
                )
            """),
            {
                "period": "all",
                "algorithm": "KMeans",
                "clusterCount": best_k,
                "totalCustomers": int(customer_time_features["nama"].nunique()),
                "totalSessions": int(df.shape[0]),
                "status": "completed",
                "sessionByTime": json.dumps(session_by_time_json),
                "heatmapData": json.dumps(heatmap_json),
                "topHourData": json.dumps(top_hour_json),
            },
        )

        run_id = run_result.lastrowid

        for _, row in cluster_summary.iterrows():
            conn.execute(
                text("""
                    INSERT INTO playtime_segment_summaries (
                        runId,
                        playtimeCluster,
                        playtimeSegment,
                        totalCustomers,
                        avgRatioPagi,
                        avgRatioSiang,
                        avgRatioMalam,
                        avgSesiPagi,
                        avgSesiSiang,
                        avgSesiMalam,
                        avgTotalSesi
                    )
                    VALUES (
                        :runId,
                        :playtimeCluster,
                        :playtimeSegment,
                        :totalCustomers,
                        :avgRatioPagi,
                        :avgRatioSiang,
                        :avgRatioMalam,
                        :avgSesiPagi,
                        :avgSesiSiang,
                        :avgSesiMalam,
                        :avgTotalSesi
                    )
                """),
                {
                    "runId": run_id,
                    "playtimeCluster": int(row["playtime_cluster"]),
                    "playtimeSegment": row["playtime_segment"],
                    "totalCustomers": int(row["total_customers"]),
                    "avgRatioPagi": float(row["avg_ratio_pagi"]),
                    "avgRatioSiang": float(row["avg_ratio_siang"]),
                    "avgRatioMalam": float(row["avg_ratio_malam"]),
                    "avgSesiPagi": float(row["avg_sesi_pagi"]),
                    "avgSesiSiang": float(row["avg_sesi_siang"]),
                    "avgSesiMalam": float(row["avg_sesi_malam"]),
                    "avgTotalSesi": float(row["avg_total_sesi"]),
                },
            )

        for _, row in customer_time_features.iterrows():
            conn.execute(
                text("""
                    INSERT INTO playtime_customer_segments (
                        runId,
                        customerName,
                        sesiPagi,
                        sesiSiang,
                        sesiMalam,
                        totalSesi,
                        ratioPagi,
                        ratioSiang,
                        ratioMalam,
                        playtimeCluster,
                        playtimeSegment,
                        activityLevel
                    )
                    VALUES (
                        :runId,
                        :customerName,
                        :sesiPagi,
                        :sesiSiang,
                        :sesiMalam,
                        :totalSesi,
                        :ratioPagi,
                        :ratioSiang,
                        :ratioMalam,
                        :playtimeCluster,
                        :playtimeSegment,
                        :activityLevel
                    )
                """),
                {
                    "runId": run_id,
                    "customerName": row["nama"],
                    "sesiPagi": int(row["sesi_pagi"]),
                    "sesiSiang": int(row["sesi_siang"]),
                    "sesiMalam": int(row["sesi_malam"]),
                    "totalSesi": int(row["total_sesi"]),
                    "ratioPagi": float(row["ratio_pagi"]),
                    "ratioSiang": float(row["ratio_siang"]),
                    "ratioMalam": float(row["ratio_malam"]),
                    "playtimeCluster": int(row["playtime_cluster"]),
                    "playtimeSegment": row["playtime_segment"],
                    "activityLevel": row["activity_level"],
                },
            )

    print(json.dumps({
        "success": True,
        "runId": run_id,
        "totalCustomers": int(customer_time_features["nama"].nunique()),
        "totalSessions": int(df.shape[0]),
    }))


if __name__ == "__main__":
    main()