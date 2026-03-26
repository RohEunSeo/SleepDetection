import cv2
import numpy as np

from face_geometry import PCF, get_metric_landmarks, procrustes_landmark_basis


def rot_mat_to_euler(rmat):
    rtr = np.transpose(rmat)
    r_identity = np.matmul(rtr, rmat)
    identity = np.identity(3, dtype=rmat.dtype)
    if np.linalg.norm(r_identity - identity) >= 1e-6:
        return None

    sy = (rmat[:2, 0] ** 2).sum() ** 0.5
    singular = sy < 1e-6
    if not singular:
        x = np.arctan2(rmat[2, 1], rmat[2, 2])
        y = np.arctan2(-rmat[2, 0], sy)
        z = np.arctan2(rmat[1, 0], rmat[0, 0])
    else:
        x = np.arctan2(-rmat[1, 2], rmat[1, 1])
        y = np.arctan2(-rmat[2, 0], sy)
        z = 0

    x = np.pi - x if x > 0 else -(np.pi + x)
    z = np.pi - z if z > 0 else -(np.pi + z)
    return (np.array([x, y, z]) * 180.0 / np.pi).round(2)


class HeadPoseEstimator:
    def __init__(self, camera_matrix=None, dist_coeffs=None, show_axis=False):
        self.NOSE_AXES_POINTS = np.array([[7, 0, 10], [0, 7, 6], [0, 0, 14]], dtype=float)
        self.JAW_LMS_NUMS = [61, 291, 199]
        self.show_axis = show_axis
        self.camera_matrix = camera_matrix
        self.dist_coeffs = dist_coeffs
        self.focal_length = None
        self.pcf_calculated = False
        self.model_lms_ids = self._get_model_lms_ids()

    def _get_model_lms_ids(self):
        model_lms_ids = self.JAW_LMS_NUMS + [key for key, _ in procrustes_landmark_basis]
        model_lms_ids.sort()
        return model_lms_ids

    def get_pose(self, frame, landmarks, frame_size):
        if not self.pcf_calculated:
            self._get_camera_parameters(frame_size)

        model_img_lms = np.clip(landmarks[self.model_lms_ids, :2], 0.0, 1.0) * frame_size
        metric_lms = get_metric_landmarks(landmarks.T.copy(), self.pcf)[0].T
        model_metric_lms = metric_lms[self.model_lms_ids, :]

        solve_ok, rvec, tvec = cv2.solvePnP(
            model_metric_lms,
            model_img_lms,
            self.camera_matrix,
            self.dist_coeffs,
            flags=cv2.SOLVEPNP_ITERATIVE,
        )
        if not solve_ok:
            return None, None, None

        tvec = tvec.round(2)
        rvec, tvec = cv2.solvePnPRefineVVS(
            model_metric_lms,
            model_img_lms,
            self.camera_matrix,
            self.dist_coeffs,
            rvec,
            tvec,
        )

        rvec1 = np.array([rvec[2, 0], rvec[0, 0], rvec[1, 0]]).reshape((3, 1))
        rmat, _ = cv2.Rodrigues(rvec1)
        eulers = rot_mat_to_euler(rmat)
        if eulers is None:
            return None, None, None

        if self.show_axis:
            self._draw_nose_axes(frame, rvec, tvec, model_img_lms)

        return float(eulers[0]), float(eulers[1]), float(eulers[2])

    def _draw_nose_axes(self, frame, rvec, tvec, model_img_lms):
        nose_axes_point2d, _ = cv2.projectPoints(
            self.NOSE_AXES_POINTS, rvec, tvec, self.camera_matrix, self.dist_coeffs
        )
        nose = tuple(model_img_lms[0, :2].astype(int))
        nose_x = tuple(nose_axes_point2d[0, 0].astype(int))
        nose_y = tuple(nose_axes_point2d[1, 0].astype(int))
        nose_z = tuple(nose_axes_point2d[2, 0].astype(int))
        cv2.line(frame, nose, nose_x, (255, 0, 0), 2)
        cv2.line(frame, nose, nose_y, (0, 255, 0), 2)
        cv2.line(frame, nose, nose_z, (0, 0, 255), 2)

    def _get_camera_parameters(self, frame_size):
        fr_w = frame_size[0]
        fr_h = frame_size[1]
        if self.camera_matrix is None:
            fr_center = (fr_w // 2, fr_h // 2)
            focal_length = fr_w
            self.camera_matrix = np.array(
                [
                    [focal_length, 0, fr_center[0]],
                    [0, focal_length, fr_center[1]],
                    [0, 0, 1],
                ],
                dtype="double",
            )
            self.focal_length = focal_length
        else:
            self.focal_length = self.camera_matrix[0, 0]

        if self.dist_coeffs is None:
            self.dist_coeffs = np.zeros((5, 1))

        self.pcf = PCF(frame_height=fr_h, frame_width=fr_w, fy=self.focal_length)
        self.pcf_calculated = True
