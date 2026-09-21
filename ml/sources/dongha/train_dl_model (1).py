import os
import time
import pandas as pd
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
import pickle

# --- 1. 설정 및 경로 ---
project_dir = r'C:\Users\김동하\OneDrive\바탕 화면\AirCraft'
dataset_path = os.path.join(project_dir, 'scripts', 'dataset_510k.csv')
model_save_path = os.path.join(project_dir, 'models', 'dl_surrogate.pth')
scaler_save_path = os.path.join(project_dir, 'models', 'dl_scaler.pkl')

BATCH_SIZE = 2048 # GPU 메모리가 크므로 큼직하게 잡습니다
EPOCHS = 50
LEARNING_RATE = 0.001

# --- 2. 모델 구조 정의 (MLP) ---
class SurrogateModel(nn.Module):
    def __init__(self, input_size=21, output_size=8):
        super(SurrogateModel, self).__init__()
        self.net = nn.Sequential(
            nn.Linear(input_size, 256),
            nn.ReLU(),
            nn.Linear(256, 256),
            nn.ReLU(),
            nn.Linear(256, 128),
            nn.ReLU(),
            nn.Linear(128, output_size)
        )

    def forward(self, x):
        return self.net(x)

# --- 3. 커스텀 Dataset 클래스 ---
class DroneDataset(Dataset):
    def __init__(self, X, y):
        self.X = torch.FloatTensor(X)
        self.y = torch.FloatTensor(y)

    def __len__(self):
        return len(self.X)

    def __getitem__(self, idx):
        return self.X[idx], self.y[idx]

# --- 4. 메인 학습 파이프라인 ---
def main():
    print(f"🚀 PyTorch 딥러닝 학습 시작")
    
    # GPU 체크
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"💻 사용 장치: {device} (GPU가 cuda로 뜨면 5070 Ti 동작 중!)")

    # 데이터 로드
    print("1. 데이터 로딩 중...")
    df = pd.read_csv(dataset_path)
    
    # 입력(X)과 타겟(y) 분리
    # design_id는 학습에 불필요하므로 제외
    X_cols = df.columns[1:22]  # speed + 20 features
    y_cols = df.columns[22:]   # 8 target metrics
    
    X = df[X_cols].values
    y = df[y_cols].values

    # 데이터 정규화 (표준화)
    print("2. 데이터 스케일링 중...")
    scaler_X = StandardScaler()
    scaler_y = StandardScaler()
    
    X_scaled = scaler_X.fit_transform(X)
    y_scaled = scaler_y.fit_transform(y)
    
    # 스케일러 저장 (나중에 예측할 때 필수)
    os.makedirs(os.path.dirname(scaler_save_path), exist_ok=True)
    with open(scaler_save_path, 'wb') as f:
        pickle.dump({'scaler_X': scaler_X, 'scaler_y': scaler_y}, f)

    # Train / Valid 분리 (8:2)
    X_train, X_val, y_train, y_val = train_test_split(X_scaled, y_scaled, test_size=0.2, random_state=42)
    
    train_dataset = DroneDataset(X_train, y_train)
    val_dataset = DroneDataset(X_val, y_val)
    
    train_loader = DataLoader(train_dataset, batch_size=BATCH_SIZE, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=BATCH_SIZE, shuffle=False)

    # 모델 초기화
    model = SurrogateModel().to(device)
    criterion = nn.MSELoss()
    optimizer = optim.Adam(model.parameters(), lr=LEARNING_RATE)

    # 학습 루프
    print("3. 모델 학습 시작...")
    start_time = time.time()
    
    for epoch in range(EPOCHS):
        model.train()
        train_loss = 0.0
        
        for batch_X, batch_y in train_loader:
            batch_X, batch_y = batch_X.to(device), batch_y.to(device)
            
            optimizer.zero_grad()
            outputs = model(batch_X)
            loss = criterion(outputs, batch_y)
            loss.backward()
            optimizer.step()
            
            train_loss += loss.item() * batch_X.size(0)
            
        train_loss /= len(train_loader.dataset)
        
        # 검증 루프
        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for batch_X, batch_y in val_loader:
                batch_X, batch_y = batch_X.to(device), batch_y.to(device)
                outputs = model(batch_X)
                loss = criterion(outputs, batch_y)
                val_loss += loss.item() * batch_X.size(0)
                
        val_loss /= len(val_loader.dataset)
        
        if (epoch+1) % 5 == 0 or epoch == 0:
            print(f"Epoch [{epoch+1}/{EPOCHS}] - Train Loss: {train_loss:.4f} | Val Loss: {val_loss:.4f}")

    end_time = time.time()
    print(f"✅ 학습 완료! (소요 시간: {end_time - start_time:.1f}초)")

    # 모델 저장
    torch.save(model.state_dict(), model_save_path)
    print(f"💾 딥러닝 가중치 저장 완료: {model_save_path}")

if __name__ == '__main__':
    main()

