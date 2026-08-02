package cn.gezhixin.smarthome.tvagent;

import android.app.Activity;
import android.os.Bundle;

public final class AgentActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        AdbSettings.enableAndSchedule(this);
        finishAndRemoveTask();
    }
}
