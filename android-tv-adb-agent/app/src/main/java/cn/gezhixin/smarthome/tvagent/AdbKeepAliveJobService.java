package cn.gezhixin.smarthome.tvagent;

import android.app.job.JobParameters;
import android.app.job.JobService;

public final class AdbKeepAliveJobService extends JobService {
    @Override
    public boolean onStartJob(JobParameters params) {
        AdbSettings.enable(this);
        return false;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }
}
