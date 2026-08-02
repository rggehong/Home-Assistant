package cn.gezhixin.smarthome.tvagent;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.provider.Settings;
import android.util.Log;

final class AdbSettings {
    static final int STARTUP_JOB_ID = 8411;
    static final int PERIODIC_JOB_ID = 8412;
    private static final String TAG = "SonyTvAdbAgent";
    private static final long PERIODIC_INTERVAL_MS = 15L * 60L * 1000L;

    private AdbSettings() {}

    static boolean enable(Context context) {
        try {
            boolean adb = Settings.Global.putInt(
                context.getContentResolver(), Settings.Global.ADB_ENABLED, 1
            );
            boolean wifi = Settings.Global.putInt(
                context.getContentResolver(), "adb_wifi_enabled", 1
            );
            Log.i(TAG, "wireless debugging enabled=" + (adb && wifi));
            return adb && wifi;
        } catch (SecurityException error) {
            Log.e(TAG, "WRITE_SECURE_SETTINGS has not been granted", error);
            return false;
        }
    }

    static void enableAndSchedule(Context context) {
        Context appContext = context.getApplicationContext();
        enable(appContext);
        JobScheduler scheduler = appContext.getSystemService(JobScheduler.class);
        if (scheduler == null) return;

        ComponentName service = new ComponentName(appContext, AdbKeepAliveJobService.class);
        scheduler.schedule(new JobInfo.Builder(STARTUP_JOB_ID, service)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setMinimumLatency(15_000L)
            .setOverrideDeadline(90_000L)
            .build());
        scheduler.schedule(new JobInfo.Builder(PERIODIC_JOB_ID, service)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true)
            .setPeriodic(PERIODIC_INTERVAL_MS)
            .build());
    }
}
